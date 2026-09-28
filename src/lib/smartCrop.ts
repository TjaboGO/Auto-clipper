import { config } from './config';
import { run } from './exec';
import type { VideoDimensions } from './probe';

export interface CropKeyframe {
  t: number; // seconds, relative to the clip's own start (0 = clip start)
  cx: number; // normalized 0..1 horizontal face center
  /** true: jump to cx at t. false: pan smoothly from the previous keyframe. */
  cut: boolean;
}

/** Run the face-tracking script over [start,end] of the source video. */
export async function computeCropKeyframes(
  videoPath: string,
  start: number,
  end: number,
  dims: VideoDimensions,
): Promise<CropKeyframe[]> {
  const { stdout } = await run('python3', [
    config.smartCropScript,
    videoPath,
    '--start', String(start),
    '--end', String(end),
    '--width', String(dims.width),
    '--height', String(dims.height),
    '--interval', '0.25',
  ]);
  const parsed = JSON.parse(stdout.trim());
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return [{ t: 0, cx: 0.5, cut: true }];
  }
  return parsed;
}

function num(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

/**
 * Turn face-tracking keyframes (normalized center-x) into an ffmpeg `crop`
 * x= expression in pixels. Between two keyframes the crop either holds and
 * then jumps (next keyframe is a cut) or pans linearly (next keyframe is a
 * pan). `t` is evaluated by ffmpeg against the clip's own timeline (0 = clip
 * start), matching how the keyframes were sampled.
 */
export function keyframesToCropXExpr(
  keyframes: CropKeyframe[],
  cropWidth: number,
  sourceWidth: number,
): string {
  const toPixelX = (cx: number): number => {
    const x = cx * sourceWidth - cropWidth / 2;
    return Math.max(0, Math.min(sourceWidth - cropWidth, Math.round(x)));
  };

  if (keyframes.length === 1) {
    return String(toPixelX(keyframes[0].cx));
  }

  // Nest from the last keyframe backwards: if(t < nextTime, segment, rest).
  // NOTE: commas here are literal - the caller wraps this whole expression
  // in single quotes (x='<expr>') before handing it to ffmpeg, and inside
  // single-quoted ffmpeg filtergraph values commas are NOT special and must
  // NOT be backslash-escaped (backslash isn't a recognized escape there
  // either, so a `\,` would be passed straight through to libavutil's eval
  // parser as a literal backslash and fail to parse).
  let expr = String(toPixelX(keyframes[keyframes.length - 1].cx));
  for (let i = keyframes.length - 2; i >= 0; i--) {
    const from = keyframes[i];
    const to = keyframes[i + 1];
    const x0 = toPixelX(from.cx);
    const x1 = toPixelX(to.cx);
    const dt = to.t - from.t;
    let segment = String(x0);
    if (!to.cut && x1 !== x0 && dt > 0) {
      const dx = x1 - x0;
      segment = `${x0}${dx < 0 ? '-' : '+'}${Math.abs(dx)}*(t-${num(from.t)})/${num(dt)}`;
    }
    expr = `if(lt(t,${num(to.t)}),${segment},${expr})`;
  }
  return expr;
}
