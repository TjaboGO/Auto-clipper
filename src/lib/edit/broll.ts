// When B-roll (stock video over the clip) is on screen: from its word on,
// for its length, on the finished clip's timeline. A later one cuts an
// earlier one short; one whose word is cut out is left out.
import type { OutputSize } from './layout';
import type { OutputWord } from './timeline';
import type { BrollVideo, ClipEdit } from './types';

export interface BrollShow {
  video: BrollVideo;
  start: number;
  end: number;
}

export function brollShows(edit: Pick<ClipEdit, 'broll'>, spoken: OutputWord[], clipLength: number): BrollShow[] {
  const shows = (edit.broll ?? [])
    .map((item) => {
      const word = spoken.find((w) => w.id === item.wordId);
      return word ? { video: item.video, start: word.start, end: Math.min(clipLength, word.start + item.duration) } : null;
    })
    .filter((s): s is BrollShow => s !== null && s.end - s.start >= 0.3)
    .sort((a, b) => a.start - b.start);
  return shows
    .map((s, i) => ({ ...s, end: Math.min(s.end, shows[i + 1]?.start ?? Infinity) }))
    .filter((s) => s.end - s.start >= 0.3);
}

/** The part of the stock video that fills the frame (cut to the frame's shape, from the middle). */
export function coverRect(video: { width: number; height: number }, out: OutputSize): { x: number; y: number; w: number; h: number } {
  const scale = Math.max(out.w / video.width, out.h / video.height);
  const w = out.w / scale;
  const h = out.h / scale;
  return { x: (video.width - w) / 2, y: (video.height - h) / 2, w, h };
}
