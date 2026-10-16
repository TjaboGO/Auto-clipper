import { config } from './config';
import { run } from './exec';
import type { AutoLayout, CropKeyframe, FacecamInfo, FramingAnalysis, GroupPerson, SourceInfo, SplitHalf } from './edit/types';

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

const share = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;

/** The webcam box from the analysis, checked, with source times. Null if it isn't usable. */
export function parseFacecam(value: unknown, start: number): FacecamInfo | null {
  const fc = value as FacecamInfo;
  if (!fc || typeof fc !== 'object' || !fc.cam) return null;
  const { x, y, w, h } = fc.cam;
  if (![x, y, w, h].every(share) || w < 0.02 || h < 0.02 || x + w > 1.001 || y + h > 1.001) return null;
  if (!validKeyframes(fc.face) || !validKeyframes(fc.content) || !share(fc.faceY)) return null;
  return {
    cam: { x, y, w: Math.min(w, 1 - x), h: Math.min(h, 1 - y) },
    found: fc.found === 'border' ? 'border' : 'guess',
    kind: fc.kind === 'game' ? 'game' : 'screen',
    face: shift(fc.face, start),
    faceY: fc.faceY,
    content: shift(fc.content, start),
  };
}

/** 3-4 people from the analysis, checked, with source times. Null if it isn't usable. */
export function parseGroup(value: unknown, start: number): GroupPerson[] | null {
  if (!Array.isArray(value) || value.length < 3 || value.length > 4) return null;
  const people = value as GroupPerson[];
  if (!people.every((p) => p && validKeyframes(p.keyframes) && share(p.faceY) && share(p.faceH) && p.faceH > 0)) return null;
  return people.map((p) => ({ keyframes: shift(p.keyframes, start), faceY: p.faceY, faceH: p.faceH }));
}

const AUTO_LAYOUTS: AutoLayout[] = ['single', 'split', 'facecam', 'screen', 'group'];

/**
 * Run the face/speaker analysis (scripts/smart_crop.py) on [start,end] of
 * the source: where the person talking is over time, the two main people
 * for a split screen if there are two, a webcam box if it looks like a
 * facecam or a screen recording, and 3-4 people for a group. Times come
 * back as source seconds. Returns null if the analysis fails - the caller
 * then crops the middle of the frame rather than failing the clip.
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
    const facecam = parseFacecam(plan.facecam, start);
    const group = parseGroup(plan.group, start);
    // The pick only stands if what it needs came through.
    let auto: AutoLayout = AUTO_LAYOUTS.includes(plan.layout) ? plan.layout : 'single';
    if ((auto === 'split' && !split) || ((auto === 'facecam' || auto === 'screen') && !facecam) || (auto === 'group' && !group)) {
      auto = 'single';
    }
    return {
      start,
      end,
      auto,
      keyframes: shift(plan.keyframes, start),
      split,
      facecam,
      group,
    };
  } catch (err) {
    console.warn('[smartCrop] face analysis failed, using a centered crop:', err);
    return null;
  }
}
