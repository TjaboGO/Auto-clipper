import { config } from './config';
import { run } from './exec';
import type { CropKeyframe, FramingAnalysis, SourceInfo, SplitHalf } from './edit/types';

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

const shift = (keyframes: CropKeyframe[], by: number): CropKeyframe[] =>
  keyframes.map((k) => ({ ...k, t: k.t + by }));

/**
 * Run the face/speaker analysis (scripts/smart_crop.py) on [start,end] of
 * the source: where the person talking is over time, and the two main
 * people for a split screen if there are two. Times come back as source
 * seconds. Returns null if the analysis fails - the caller then crops the
 * middle of the frame rather than failing the clip.
 */
export async function analyzeFraming(
  videoPath: string,
  start: number,
  end: number,
  source: SourceInfo,
): Promise<FramingAnalysis | null> {
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
        '--width', String(source.width),
        '--height', String(source.height),
        '--model', config.faceModel,
      ],
      {},
      timeoutMs,
    );
    const plan = JSON.parse(stdout.trim().split('\n').pop() || '{}');
    if (!validKeyframes(plan.keyframes)) return null;
    const split =
      plan.split && validHalf(plan.split.top) && validHalf(plan.split.bottom)
        ? {
            top: { ...plan.split.top, keyframes: shift(plan.split.top.keyframes, start) },
            bottom: { ...plan.split.bottom, keyframes: shift(plan.split.bottom.keyframes, start) },
          }
        : null;
    return {
      start,
      end,
      auto: plan.layout === 'split' && split ? 'split' : 'single',
      keyframes: shift(plan.keyframes, start),
      split,
    };
  } catch (err) {
    console.warn('[smartCrop] face analysis failed, using a centered crop:', err);
    return null;
  }
}
