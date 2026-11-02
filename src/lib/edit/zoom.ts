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
