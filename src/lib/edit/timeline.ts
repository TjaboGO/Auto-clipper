import type { ClipEdit, CropKeyframe, EditorWord, ReframeKey, TimeRange } from './types';

// Silence kept on each side of a stretch of removed words, so the speech
// around a cut still has room to breathe ...
const KEEP_AROUND_CUT = 0.12;
// ... and after the last word, when the rest of the clip is cut away.
const KEEP_AT_END = 0.3;
// "Remove pauses": silences longer than this shrink to 2 x PAUSE_KEEP.
const PAUSE_LONGER_THAN = 0.5;
const PAUSE_KEEP = 0.15;
// Kept pieces shorter than this are dropped (a blip between two cuts).
const MIN_KEPT = 0.08;
// Clip edges set from a word: start a little before it, let the last one
// ring out (the same as the pipeline's snapping in wordTiming.ts).
const LEAD_IN = 0.12;
const TAIL_OUT = 0.35;

/** Words that belong to the clip: those whose middle falls inside it. */
export function clipWords(words: EditorWord[], range: TimeRange): EditorWord[] {
  return words.filter((w) => {
    const mid = (w.start + w.end) / 2;
    return mid >= range.start && mid <= range.end;
  });
}

/** Ids of the words cut out of the video: deleted by hand, plus fillers if asked. */
export function removedWordIds(edit: ClipEdit, words: EditorWord[]): Set<string> {
  const removed = new Set(edit.deleted);
  if (edit.removeFillers) {
    for (const w of words) if (w.filler) removed.add(w.id);
  }
  return removed;
}

function mergeRanges(ranges: TimeRange[]): TimeRange[] {
  const sorted = ranges.filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
  const merged: TimeRange[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end + 0.02) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}

/**
 * Stretches of the source cut out of the clip: every run of removed words
 * (with most of the silence around it), and long pauses if asked.
 */
export function computeCuts(edit: ClipEdit, words: EditorWord[]): TimeRange[] {
  const inClip = clipWords(words, edit);
  const removed = removedWordIds(edit, inClip);
  const cuts: TimeRange[] = [];

  for (let i = 0; i < inClip.length; ) {
    if (!removed.has(inClip[i].id)) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < inClip.length && removed.has(inClip[j + 1].id)) j++;
    const prev = inClip[i - 1];
    const next = inClip[j + 1];
    const keepAfterPrev = next ? KEEP_AROUND_CUT : KEEP_AT_END;
    const from = prev
      ? prev.end + Math.min(keepAfterPrev, Math.max(0, inClip[i].start - prev.end))
      : edit.start;
    const to = next
      ? next.start - Math.min(KEEP_AROUND_CUT, Math.max(0, next.start - inClip[j].end))
      : edit.end;
    cuts.push({ start: Math.max(edit.start, from), end: Math.min(edit.end, to) });
    i = j + 1;
  }

  if (edit.removePauses) {
    const kept = inClip.filter((w) => !removed.has(w.id));
    for (let k = 1; k < kept.length; k++) {
      const gap = kept[k].start - kept[k - 1].end;
      if (gap > PAUSE_LONGER_THAN) {
        cuts.push({ start: kept[k - 1].end + PAUSE_KEEP, end: kept[k].start - PAUSE_KEEP });
      }
    }
  }
  return mergeRanges(cuts);
}

/** The parts of the source that end up in the clip, in order. */
export function keptRanges(edit: ClipEdit, words: EditorWord[]): TimeRange[] {
  const kept: TimeRange[] = [];
  let cursor = edit.start;
  for (const cut of computeCuts(edit, words)) {
    if (cut.start > cursor) kept.push({ start: cursor, end: cut.start });
    cursor = Math.max(cursor, cut.end);
  }
  if (edit.end > cursor) kept.push({ start: cursor, end: edit.end });
  return kept.filter((r) => r.end - r.start >= MIN_KEPT);
}

export function outputDuration(kept: TimeRange[]): number {
  return kept.reduce((sum, r) => sum + r.end - r.start, 0);
}

/** Where source time `t` lands in the finished clip, or null if it was cut. */
export function toOutputTime(kept: TimeRange[], t: number): number | null {
  let before = 0;
  for (const r of kept) {
    if (t < r.start - 1e-6) return null;
    if (t <= r.end + 1e-6) return before + Math.min(Math.max(t, r.start), r.end) - r.start;
    before += r.end - r.start;
  }
  return null;
}

/** The source time shown at time `o` of the finished clip. */
export function toSourceTime(kept: TimeRange[], o: number): number {
  let left = Math.max(0, o);
  for (const r of kept) {
    const length = r.end - r.start;
    if (left <= length) return r.start + left;
    left -= length;
  }
  return kept.length > 0 ? kept[kept.length - 1].end : 0;
}

/** For playback: `t` if it's kept, else the start of the next kept part (null after the end). */
export function playableTime(kept: TimeRange[], t: number): number | null {
  for (const r of kept) {
    if (t < r.start) return r.start;
    if (t < r.end) return t;
  }
  return null;
}

/** A caption word on the finished clip's timeline. */
export interface OutputWord {
  id: string;
  text: string;
  start: number;
  end: number;
  seg: number;
  emphasis: boolean;
}

/** The words the captions show: kept, not hidden, with the user's spelling. */
export function outputWords(edit: ClipEdit, words: EditorWord[], kept: TimeRange[]): OutputWord[] {
  const inClip = clipWords(words, edit);
  const removed = removedWordIds(edit, inClip);
  const out: OutputWord[] = [];
  for (const w of inClip) {
    const override = edit.words[w.id];
    if (removed.has(w.id) || override?.hidden) continue;
    const text = (override?.text ?? w.text).trim();
    if (!text) continue;
    // The word's time on the output timeline (the parts of it that are kept).
    let start: number | null = null;
    let end: number | null = null;
    let before = 0;
    for (const r of kept) {
      const from = Math.max(r.start, w.start);
      const to = Math.min(r.end, w.end);
      if (to > from) {
        if (start === null) start = before + from - r.start;
        end = before + to - r.start;
      }
      before += r.end - r.start;
    }
    if (start === null || end === null) continue;
    out.push({ id: w.id, text, start, end, seg: w.seg, emphasis: override?.emphasis === true });
  }
  return out;
}

/** Clip start just before word `index`: a little lead-in, not reaching into the word before. */
export function startBeforeWord(words: EditorWord[], index: number, window: TimeRange): number {
  const word = words[index];
  const prev = words[index - 1];
  const start = Math.max(
    word.start - LEAD_IN,
    prev ? Math.min(prev.end + 0.03, word.start - 0.02) : -Infinity,
  );
  return Math.max(window.start, start);
}

/** Clip end just after word `index`: let it ring out, without reaching into the next word. */
export function endAfterWord(words: EditorWord[], index: number, window: TimeRange): number {
  const word = words[index];
  const next = words[index + 1];
  const end = Math.min(
    word.end + TAIL_OUT,
    next ? Math.max(next.start - 0.03, word.end + 0.02) : Infinity,
  );
  return Math.min(window.end, end);
}

/** Crop center at time `t`: holds until a cut keyframe, pans in a straight line otherwise. */
export function cxAt(keyframes: CropKeyframe[], t: number): number {
  if (keyframes.length === 0) return 0.5;
  if (t <= keyframes[0].t) return keyframes[0].cx;
  for (let i = 0; i < keyframes.length - 1; i++) {
    const a = keyframes[i];
    const b = keyframes[i + 1];
    if (t < b.t) {
      if (b.cut || b.t <= a.t) return a.cx;
      return a.cx + ((b.cx - a.cx) * (t - a.t)) / (b.t - a.t);
    }
  }
  return keyframes[keyframes.length - 1].cx;
}

function dedupeKeyframes(keyframes: CropKeyframe[]): CropKeyframe[] {
  const out: CropKeyframe[] = [];
  for (const k of keyframes) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.t - k.t) < 0.001) out[out.length - 1] = k;
    else out.push(k);
  }
  return out;
}

/**
 * The speaker-following keyframes with the user's manual framing applied:
 * from each key on, a fixed crop, or back to following the speaker.
 */
export function applyReframe(auto: CropKeyframe[], reframe: ReframeKey[]): CropKeyframe[] {
  if (reframe.length === 0) return auto;
  const keys = [...reframe].sort((a, b) => a.t - b.t);
  const out: CropKeyframe[] = auto.filter((k) => k.t < keys[0].t);
  keys.forEach((key, i) => {
    const until = i + 1 < keys.length ? keys[i + 1].t : Infinity;
    if (key.cx !== null) {
      out.push({ t: key.t, cx: key.cx, cut: true });
    } else {
      out.push({ t: key.t, cx: cxAt(auto, key.t), cut: true });
      out.push(...auto.filter((k) => k.t > key.t && k.t < until));
    }
  });
  return dedupeKeyframes(out);
}

/**
 * Keyframes on the clip's own timeline (0 = `from`, where ffmpeg starts
 * reading): the position at `from`, then every keyframe up to and including
 * the first one after `to` (it can shape a pan that runs past the end).
 */
export function keyframesForRange(keyframes: CropKeyframe[], from: number, to: number): CropKeyframe[] {
  if (keyframes.length === 0) return [{ t: 0, cx: 0.5, cut: true }];
  const out: CropKeyframe[] = [{ t: 0, cx: cxAt(keyframes, from), cut: true }];
  for (const k of keyframes) {
    if (k.t <= from) continue;
    out.push({ ...k, t: k.t - from });
    if (k.t >= to) break;
  }
  return out;
}
