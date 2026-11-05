// Automatic zoom: short punch-ins that give a talking clip some life, the
// way editors cut between a wide and a close shot. Every second sentence is
// shown closer, and a key word in between gets a short punch-in of its own.
// Only for the follow-the-speaker layout (one picture to zoom into).
import type { OutputWord } from './timeline';
import type { TimeRange } from './types';

export type ZoomLevel = 'off' | 'light' | 'medium' | 'strong';

export const ZOOM_LEVELS: { id: ZoomLevel; label: string; factor: number }[] = [
  { id: 'off', label: 'Av', factor: 1 },
  { id: 'light', label: 'Lätt', factor: 1.1 },
  { id: 'medium', label: 'Mellan', factor: 1.18 },
  { id: 'strong', label: 'Stark', factor: 1.28 },
];

export function zoomFactor(level: ZoomLevel | undefined): number {
  return ZOOM_LEVELS.find((l) => l.id === level)?.factor ?? 1;
}

/** The point that stays put when zooming in (shares of the frame): the middle, a bit up where faces are. */
export const ZOOM_CENTER = { x: 0.5, y: 0.4 };

const MAX_SENTENCE_ZOOM = 4;
const PUNCH = 0.6;
const MIN_ZOOM = 0.8;
const MIN_GAP = 0.5;

/** When the clip is zoomed in (clip timeline). */
export function zoomSegments(words: OutputWord[], clipLength: number): TimeRange[] {
  const sentences: OutputWord[][] = [];
  for (const w of words) {
    const last = sentences[sentences.length - 1];
    if (last && last[0].seg === w.seg) last.push(w);
    else sentences.push([w]);
  }
  const raw: TimeRange[] = [];
  sentences.forEach((sentence, i) => {
    if (i % 2 === 1) {
      const start = sentence[0].start;
      raw.push({ start, end: Math.min(sentence[sentence.length - 1].end + 0.1, start + MAX_SENTENCE_ZOOM) });
      return;
    }
    // A key word in a wide sentence: a short punch-in.
    for (const w of sentence) {
      if (w.emphasis) raw.push({ start: w.start, end: Math.max(w.end + PUNCH, w.start + MIN_ZOOM) });
    }
  });
  const merged: TimeRange[] = [];
  for (const r of raw.sort((a, b) => a.start - b.start)) {
    const range = { start: Math.max(0, r.start - 0.05), end: Math.min(clipLength, r.end) };
    const last = merged[merged.length - 1];
    if (last && range.start - last.end < MIN_GAP) last.end = Math.max(last.end, range.end);
    else merged.push(range);
  }
  return merged.filter((r) => r.end - r.start >= 0.5);
}

export function zoomedAt(segments: TimeRange[], t: number): boolean {
  return segments.some((s) => t >= s.start && t < s.end);
}

/**
 * The part of a crop box that's shown when zoomed in by `factor`, keeping
 * ZOOM_CENTER in place: the same as scaling the frame up and cutting it
 * back to size, which is what the render does.
 */
export function zoomBox(box: { x: number; y: number; w: number; h: number }, factor: number) {
  const w = box.w / factor;
  const h = box.h / factor;
  return { x: box.x + (box.w - w) * ZOOM_CENTER.x, y: box.y + (box.h - h) * ZOOM_CENTER.y, w, h };
}

// ---------------------------------------------------------------------------
// Smooth zoom and transitions at the cuts

/** 'smooth': glide in and out. 'cut': jump, like switching camera angles. */
export type ZoomStyle = 'smooth' | 'cut';

/** What happens where words or pauses were cut out. */
export type CutTransition = 'none' | 'punch' | 'flash';

export const ZOOM_STYLES: { id: ZoomStyle; label: string }[] = [
  { id: 'smooth', label: 'Mjuk' },
  { id: 'cut', label: 'Hopp' },
];

export const CUT_TRANSITIONS: { id: CutTransition; label: string; hint: string }[] = [
  { id: 'none', label: 'Ingen', hint: 'Klippen syns som de är.' },
  { id: 'punch', label: 'Zooma varannan', hint: 'Varannan del visas lite närmare, så att hoppen i bilden döljs.' },
  { id: 'flash', label: 'Blixt', hint: 'En kort vit blixt vid varje klipp.' },
];

/**
 * A smooth zoom snaps in, holds and drifts out: quick in, slower out, the
 * way a camera operator pushes in (the shape OpenShorts' punch-in uses).
 */
export const ZOOM_RAMP = 0.25;
export const ZOOM_FALL = 0.55;
/** How close "Zooma varannan" goes when the clip has no zoom of its own. */
export const PUNCH_FACTOR = 1.12;
/** The flash at a cut: from a little before to a little after, at this strength. */
export const FLASH = { before: 0.03, after: 0.09, alpha: 0.45 };

/** A stretch of the finished clip that's zoomed in, and how long it glides in (0 = jump) and out. */
export interface ZoomSpan extends TimeRange {
  ramp: number;
  /** Seconds to glide out (the same as `ramp` if not set). */
  fall?: number;
}

export interface ZoomPlan {
  factor: number;
  spans: ZoomSpan[];
}

/** Where the cuts are in the finished clip (between the kept parts). */
export function cutTimes(kept: TimeRange[]): number[] {
  const times: number[] = [];
  let at = 0;
  kept.forEach((r, i) => {
    at += r.end - r.start;
    if (i < kept.length - 1) times.push(at);
  });
  return times;
}

/** Every second kept part, on the finished clip's timeline (for "Zooma varannan"). */
export function punchSpans(kept: TimeRange[]): ZoomSpan[] {
  const spans: ZoomSpan[] = [];
  let at = 0;
  kept.forEach((r, i) => {
    const length = r.end - r.start;
    if (i % 2 === 1) spans.push({ start: at, end: at + length, ramp: 0 });
    at += length;
  });
  return spans;
}

/** When the flashes show, on the finished clip's timeline. */
export function flashWindows(kept: TimeRange[]): TimeRange[] {
  return cutTimes(kept).map((t) => ({ start: Math.max(0, t - FLASH.before), end: t + FLASH.after }));
}

/**
 * The clip's zooms: the automatic ones (smooth or jumping) and "Zooma
 * varannan" at the cuts (always a jump, since the picture jumps there
 * anyway). Null when nothing zooms.
 */
export function zoomPlan(
  edit: { zoom: ZoomLevel; zoomStyle?: ZoomStyle; transition?: CutTransition },
  spoken: OutputWord[],
  kept: TimeRange[],
  clipLength: number,
): ZoomPlan | null {
  const spans: ZoomSpan[] = [];
  if (edit.zoom !== 'off') {
    const smooth = edit.zoomStyle === 'smooth';
    spans.push(...zoomSegments(spoken, clipLength).map((r) => ({ ...r, ramp: smooth ? ZOOM_RAMP : 0, fall: smooth ? ZOOM_FALL : 0 })));
  }
  if (edit.transition === 'punch') spans.push(...punchSpans(kept));
  if (spans.length === 0) return null;
  return { factor: edit.zoom !== 'off' ? zoomFactor(edit.zoom) : PUNCH_FACTOR, spans: spans.sort((a, b) => a.start - b.start) };
}

const ease = (x: number) => x * x * (3 - 2 * x);

/** How far in one span is at `t`, 0-1 (eased in and out; a span shorter than its glides never gets all the way). */
function spanAmount(span: ZoomSpan, t: number): number {
  if (span.ramp <= 0) return t >= span.start && t < span.end ? 1 : 0;
  const fall = span.fall ?? span.ramp;
  const rise = Math.min(1, Math.max(0, (t - span.start) / span.ramp));
  const out = fall > 0 ? Math.min(1, Math.max(0, (span.end - t) / fall)) : t < span.end ? 1 : 0;
  return ease(rise) * ease(out);
}

/** How zoomed in the clip is at `t`, 0-1: the strongest zoom there (overlaps don't add up). */
export function zoomAmount(plan: ZoomPlan | null, t: number): number {
  if (!plan) return 0;
  return plan.spans.reduce((most, s) => Math.max(most, spanAmount(s, t)), 0);
}

function n(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/** The ffmpeg expression for how zoomed in the clip is (0-1), in the time variable `t`: the same as zoomAmount. */
export function zoomAmountExpr(plan: ZoomPlan, t = 'it'): string {
  const eased = (x: string) => `${x}*${x}*(3-2*${x})`;
  const terms = plan.spans.map((s) => {
    if (s.ramp <= 0) return `between(${t},${n(s.start)},${n(s.end)})`;
    const fall = s.fall ?? s.ramp;
    const rise = `clip((${t}-${n(s.start)})/${n(s.ramp)},0,1)`;
    const out = fall > 0 ? `clip((${n(s.end)}-${t})/${n(fall)},0,1)` : `lt(${t},${n(s.end)})`;
    return `${eased(rise)}*${eased(out)}`;
  });
  // max(a,max(b,c)): the strongest zoom wins.
  return terms.reduceRight((acc, term) => (acc ? `max(${term},${acc})` : term), '');
}

/** Whether any of the plan glides (else the render can use the cheaper jump). */
export function planGlides(plan: ZoomPlan | null): boolean {
  return !!plan && plan.spans.some((s) => s.ramp > 0);
}
