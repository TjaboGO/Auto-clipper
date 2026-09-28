import path from 'path';
import { run } from './exec';

export interface CropKeyframe {
  t: number; // seconds, relative to the clip's own start (0 = clip start)
  cx: number; // normalized 0..1 horizontal face center
}

const SCRIPT_PATH = path.join(process.cwd(), 'scripts', 'smart_crop.py');

/** Run the OpenCV face-tracking script over [start,end] of the source video. */
export async function computeCropKeyframes(
  videoPath: string,
  start: number,
  end: number,
): Promise<CropKeyframe[]> {
  const { stdout } = await run('python3', [
    SCRIPT_PATH,
    videoPath,
    '--start',
    String(start),
    '--end',
    String(end),
    '--interval',
    '0.5',
  ]);
  const parsed = JSON.parse(stdout.trim());
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return [{ t: 0, cx: 0.5 }];
  }
  return parsed;
}

/**
 * Turn face-tracking keyframes (normalized center-x) into an ffmpeg `crop`
 * x= expression in pixels, as a step function: the crop x holds each
 * keyframe's value until the next keyframe's time is reached. `t` in the
 * generated expression is evaluated by ffmpeg against the clip's own
 * timeline (0 = clip start), matching how the keyframes were sampled.
 */
export function keyframesToCropXExpr(
  keyframes: CropKeyframe[],
  cropWidth: number,
  sourceWidth: number,
): string {
  const toPixelX = (cx: number): number => {
    const centerPx = cx * sourceWidth;
    const x = centerPx - cropWidth / 2;
    return Math.max(0, Math.min(sourceWidth - cropWidth, Math.round(x)));
  };

  if (keyframes.length === 1) {
    return String(toPixelX(keyframes[0].cx));
  }

  // Nest from the last keyframe backwards: if(t < nextBoundary, thisX, ...)
  // NOTE: commas here are literal - the caller wraps this whole expression
  // in single quotes (x='<expr>') before handing it to ffmpeg, and inside
  // single-quoted ffmpeg filtergraph values commas are NOT special and must
  // NOT be backslash-escaped (backslash isn't a recognized escape there
  // either, so a `\,` would be passed straight through to libavutil's eval
  // parser as a literal backslash and fail to parse).
  let expr = String(toPixelX(keyframes[keyframes.length - 1].cx));
  for (let i = keyframes.length - 2; i >= 0; i--) {
    const boundary = keyframes[i + 1].t;
    const x = toPixelX(keyframes[i].cx);
    expr = `if(lt(t,${boundary}),${x},${expr})`;
  }
  return expr;
}
