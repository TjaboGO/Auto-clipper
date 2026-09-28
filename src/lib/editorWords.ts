import { estimateWordTimings, isFiller, type ClipTiming } from './wordTiming';
import type { EditorWord, SourceInfo, TimeRange } from './edit/types';
import type { TimedWord, TranscriptSegment } from './types';

/** How much of the source around a clip the editor can reach (to lengthen it). */
export const EDIT_MARGIN_SECONDS = 30;

function withIds(words: TimedWord[]): (TimedWord & { id: string })[] {
  const counters = new Map<number, number>();
  return words.map((w) => {
    const index = counters.get(w.seg) ?? 0;
    counters.set(w.seg, index + 1);
    return { ...w, id: `${w.seg}:${index}` };
  });
}

/** Squeeze a run of estimated words into [from, to], keeping their proportions. */
function squeeze(words: EditorWord[], from: number, to: number): void {
  const start = words[0].start;
  const span = words[words.length - 1].end - start || 1;
  const scale = (to - from) / span;
  for (const w of words) {
    w.start = from + (w.start - start) * scale;
    w.end = from + (w.end - start) * scale;
  }
}

/**
 * All transcript words in the editor's window around a clip: Whisper's
 * times where the pipeline has them (the clip's own sentences), estimated
 * from Gemini's sentence times elsewhere. Estimated sentences right next to
 * the exact ones are squeezed so they don't overlap them (Gemini's times
 * can be half a second off, Whisper's aren't).
 */
export function buildEditorWords(
  transcript: TranscriptSegment[],
  window: TimeRange,
  timing: ClipTiming,
): EditorWord[] {
  const exact = new Map(timing.exact ? withIds(timing.words).map((w) => [w.id, w]) : []);
  const words: EditorWord[] = withIds(estimateWordTimings(transcript, window.start, window.end)).map((w) => {
    const heard = exact.get(w.id);
    return {
      id: w.id,
      text: w.text,
      start: heard?.start ?? w.start,
      end: heard?.end ?? w.end,
      seg: w.seg,
      exact: !!heard,
      filler: isFiller(w.text),
    };
  });
  if (exact.size === 0) return words;

  const exactWords = words.filter((w) => w.exact);
  const first = exactWords[0];
  const last = exactWords[exactWords.length - 1];
  const segments = new Map<number, EditorWord[]>();
  for (const w of words) {
    if (w.exact) continue;
    const list = segments.get(w.seg) ?? [];
    list.push(w);
    segments.set(w.seg, list);
  }
  for (const [seg, list] of segments) {
    const start = list[0].start;
    const end = list[list.length - 1].end;
    const need = 0.1 * list.length;
    if (seg < first.seg && end > first.start - 0.05) {
      const to = first.start - 0.05;
      squeeze(list, Math.min(start, to - need), to);
    } else if (seg > last.seg && start < last.end + 0.05) {
      const from = last.end + 0.05;
      squeeze(list, from, Math.max(end, from + need));
    }
  }
  return words;
}

/** The editor's window around a clip. */
export function editWindow(clip: TimeRange, durationSec: number): TimeRange {
  return {
    start: Math.max(0, clip.start - EDIT_MARGIN_SECONDS),
    end: Math.min(durationSec, clip.end + EDIT_MARGIN_SECONDS),
  };
}

/** Whether the face analysis is worth running: only a source wider than 9:16 is ever cropped sideways. */
export function needsFramingAnalysis(source: SourceInfo): boolean {
  return source.width / source.height > 1080 / 1920 + 0.01;
}

