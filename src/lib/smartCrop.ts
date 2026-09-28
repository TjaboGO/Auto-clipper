import { config } from './config';
import { run } from './exec';
import { probeDimensions, type VideoDimensions } from './probe';

// Standard short-form vertical output resolution (TikTok/Reels/Shorts).
export const OUTPUT_WIDTH = 1080;
export const OUTPUT_HEIGHT = 1920;

export interface CropKeyframe {
  t: number; // seconds, relative to the clip's own start (0 = clip start)
  cx: number; // normalized 0..1 horizontal face center
  /** true: jump to cx at t. false: pan smoothly from the previous keyframe. */
  cut: boolean;
}

/** One person's crop in a split screen: pans with them, fixed zoom. */
export interface SplitHalf {
  keyframes: CropKeyframe[];
  /** Top of the crop, as a share of the frame height. */
  y: number;
  /** Crop height, as a share of the frame height. */
  h: number;
}

/**
 * How a clip is framed in 9:16:
 *  - letterbox: the source is already that narrow, scale it and pad
 *  - single: crop that follows one person at a time (whoever is talking)
 *  - split: two people stacked, each in their own crop (top = left person)
 */
export type Framing =
  | { layout: 'letterbox'; dims: VideoDimensions }
  | { layout: 'single'; dims: VideoDimensions; keyframes: CropKeyframe[] }
  | { layout: 'split'; dims: VideoDimensions; top: SplitHalf; bottom: SplitHalf };

function validKeyframes(value: unknown): value is CropKeyframe[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((k) => Number.isFinite(k?.t) && Number.isFinite(k?.cx) && typeof k?.cut === 'boolean')
  );
}

function validHalf(value: unknown): value is SplitHalf {
  const half = value as SplitHalf;
  return !!half && validKeyframes(half.keyframes) && Number.isFinite(half.y) && Number.isFinite(half.h);
}

/**
 * Decide how to frame [start,end] of the source: run the face/speaker
 * analysis (scripts/smart_crop.py) when the source is wider than 9:16. If
 * the analysis fails, fall back to a centered crop rather than failing the
 * clip.
 */
export async function planFraming(videoPath: string, start: number, end: number): Promise<Framing> {
  const dims = await probeDimensions(videoPath);
  if (dims.width / dims.height <= OUTPUT_WIDTH / OUTPUT_HEIGHT) {
    return { layout: 'letterbox', dims };
  }
  const centered: Framing = { layout: 'single', dims, keyframes: [{ t: 0, cx: 0.5, cut: true }] };
  // Normally a few seconds per clip. A stuck analysis must not hold up the queue.
  const timeoutMs = Math.max(120, 4 * (end - start)) * 1000;
  try {
    const { stdout } = await run(
      'python3',
      [
        config.smartCropScript,
        videoPath,
        '--start', String(start),
        '--end', String(end),
        '--width', String(dims.width),
        '--height', String(dims.height),
        '--model', config.faceModel,
      ],
      {},
      timeoutMs,
    );
    const plan = JSON.parse(stdout.trim().split('\n').pop() || '{}');
    if (plan.layout === 'split' && validHalf(plan.top) && validHalf(plan.bottom)) {
      return { layout: 'split', dims, top: plan.top, bottom: plan.bottom };
    }
    return validKeyframes(plan.keyframes) ? { layout: 'single', dims, keyframes: plan.keyframes } : centered;
  } catch (err) {
    console.warn('[smartCrop] face analysis failed, using a centered crop:', err);
    return centered;
  }
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

function even(n: number): number {
  return Math.max(2, Math.floor(n / 2) * 2);
}

/**
 * The ffmpeg video filter for a framing, ending with `captionsFilter`.
 * Returns ffmpeg arguments: `-vf ...` for one chain, or `-filter_complex
 * ... -map` for the split screen (which needs two crops of the input).
 */
export function framingFilterArgs(framing: Framing, captionsFilter: string): string[] {
  const { width, height } = framing.dims;
  if (framing.layout === 'letterbox') {
    return [
      '-vf',
      `scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease,` +
        `pad=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,${captionsFilter}`,
    ];
  }
  if (framing.layout === 'single') {
    const cropWidth = even((height * OUTPUT_WIDTH) / OUTPUT_HEIGHT);
    const x = keyframesToCropXExpr(framing.keyframes, cropWidth, width);
    return [
      '-vf',
      `crop=w=${cropWidth}:h=${height}:x='${x}':y=0,scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT},setsar=1,${captionsFilter}`,
    ];
  }
  // Split screen: each half is 1080x960 (9:8), cropped around its person.
  const halfHeight = OUTPUT_HEIGHT / 2;
  const crop = (half: SplitHalf): string => {
    const cropHeight = Math.min(even(height), even(half.h * height));
    const cropWidth = Math.min(even(width), even((cropHeight * OUTPUT_WIDTH) / halfHeight));
    const y = Math.max(0, Math.min(height - cropHeight, Math.round(half.y * height)));
    const x = keyframesToCropXExpr(half.keyframes, cropWidth, width);
    return `crop=w=${cropWidth}:h=${cropHeight}:x='${x}':y=${y},scale=${OUTPUT_WIDTH}:${halfHeight}`;
  };
  return [
    '-filter_complex',
    `[0:v]split=2[first][second];[first]${crop(framing.top)}[top];[second]${crop(framing.bottom)}[bottom];` +
      `[top][bottom]vstack=inputs=2,setsar=1,${captionsFilter}[out]`,
    '-map', '[out]',
    '-map', '0:a?',
  ];
}
