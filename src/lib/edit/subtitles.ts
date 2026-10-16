// Subtitle files (SRT and WebVTT) for a finished clip: the same words as
// the burned-in captions (cuts, corrections, hidden words and translation
// included), but in the size subtitles usually have - up to two lines of
// about 42 characters, never across two sentences.
import { captionPages } from './captionLayout';
import type { OutputWord } from './timeline';

const LINE_CHARS = 42;
const CUE_WORDS = 16;

export interface SubtitleCue {
  start: number;
  end: number;
  lines: string[];
}

/** Two lines as even as possible when the text doesn't fit on one. */
function splitLines(text: string): string[] {
  if (text.length <= LINE_CHARS) return [text];
  const words = text.split(' ');
  let best = 1;
  let bestDiff = Infinity;
  for (let i = 1; i < words.length; i++) {
    const top = words.slice(0, i).join(' ').length;
    const bottom = words.slice(i).join(' ').length;
    const diff = Math.abs(top - bottom);
    if (diff < bestDiff) {
      best = i;
      bestDiff = diff;
    }
  }
  return [words.slice(0, best).join(' '), words.slice(best).join(' ')];
}

export function subtitleCues(words: OutputWord[], clipLength: number): SubtitleCue[] {
  const pages = captionPages(words, clipLength, { maxWords: CUE_WORDS, maxChars: 2 * LINE_CHARS, uppercase: false });
  return pages.map((page, i) => {
    // Up as long as the burned-in captions keep the last word up: through
    // short pauses, cleared a moment after a long one.
    const next = pages[i + 1];
    let end = Math.min(page[page.length - 1].until, clipLength);
    if (next) end = Math.min(end, next[0].start);
    const start = page[0].start;
    return { start, end: Math.max(end, start + 0.3), lines: splitLines(page.map((w) => w.text).join(' ')) };
  });
}

function stamp(seconds: number, separator: ',' | '.'): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}${separator}${pad(ms % 1000, 3)}`;
}

export function buildSrt(cues: SubtitleCue[]): string {
  return cues.map((c, i) => `${i + 1}\n${stamp(c.start, ',')} --> ${stamp(c.end, ',')}\n${c.lines.join('\n')}\n`).join('\n');
}

export function buildVtt(cues: SubtitleCue[]): string {
  return `WEBVTT\n\n${cues.map((c) => `${stamp(c.start, '.')} --> ${stamp(c.end, '.')}\n${c.lines.join('\n')}\n`).join('\n')}`;
}
