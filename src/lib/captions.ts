import fs from 'fs';
import path from 'path';
import type { TimedWord } from './types';

/** Escape a filesystem path for use as an ffmpeg filtergraph option value. */
export function escapeFfmpegFilterPath(p: string): string {
  return p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

/**
 * Caption font. The TTF ships in assets/fonts and is handed to libass via
 * the ass filter's `fontsdir`, so captions look the same on every machine
 * instead of depending on whatever fonts the server happens to have.
 */
export const CAPTION_FONT = 'Montserrat ExtraBold';

// Style colours are &HAABBGGRR (alpha, blue, green, red); inline \c tags
// take &HBBGGRR&.
const TEXT_COLOUR = '&H00FFFFFF'; // white
const OUTLINE_COLOUR = '&H00000000'; // black
const SHADOW_COLOUR = '&H80000000'; // half-transparent black
const HIGHLIGHT_TAG = '{\\c&H00D7FF&}'; // gold (#FFD700)

// A caption "page" is the group of words shown on screen at once. Short
// pages read better on a phone than whole sentences.
const MAX_WORDS_PER_PAGE = 5;
const MAX_CHARS_PER_PAGE = 24;

// Between words the caption stays up (no flicker in the short gaps real
// speech has). Only a pause longer than MAX_HOLD clears it, after TAIL_HOLD.
const MAX_HOLD = 0.8;
const TAIL_HOLD = 0.3;

function formatAssTime(seconds: number): string {
  // Work in whole centiseconds so rounding can never produce "60.00" seconds.
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const frac = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(frac).padStart(2, '0')}`;
}

function escapeAssText(text: string): string {
  // Curly braces start ASS override tags and backslashes start escapes like
  // \N - neutralize both so spoken text can't break the tags we insert.
  return text.replace(/\\/g, '/').replace(/\{/g, '(').replace(/\}/g, ')');
}

/** A word on the clip's own timeline, shown from `start` until `until`. */
interface CaptionWord {
  text: string;
  start: number;
  until: number;
  seg: number;
}

function pageChars(page: CaptionWord[]): number {
  return page.reduce((sum, w) => sum + w.text.length, 0) + Math.max(0, page.length - 1);
}

function paginate(words: CaptionWord[]): CaptionWord[][] {
  const pages: CaptionWord[][] = [];
  let page: CaptionWord[] = [];
  for (const word of words) {
    const fits =
      page.length < MAX_WORDS_PER_PAGE && pageChars([...page, word]) <= MAX_CHARS_PER_PAGE;
    if (page.length > 0 && !fits) {
      pages.push(page);
      page = [];
    }
    page.push(word);
  }
  if (page.length > 0) pages.push(page);

  // Don't leave a single word alone on the last page if the page before can
  // spare one ("konsekvent arbete" + "varje dag", not "... varje" + "dag").
  if (pages.length >= 2) {
    const last = pages[pages.length - 1];
    const prev = pages[pages.length - 2];
    if (last.length === 1 && prev.length >= 3) {
      const moved = [prev[prev.length - 1], ...last];
      if (pageChars(moved) <= MAX_CHARS_PER_PAGE) {
        pages[pages.length - 2] = prev.slice(0, -1);
        pages[pages.length - 1] = moved;
      }
    }
  }
  return pages;
}

export interface AssStyleOptions {
  fontSize?: number;
  /** distance from the bottom edge, in px, on the 1080x1920 output canvas */
  marginV?: number;
  /** ASS numpad alignment: 2 = bottom center (default), 5 = middle center */
  alignment?: number;
}

/** Captions on the seam between the two people of a split screen. */
export const SPLIT_SCREEN_CAPTIONS: AssStyleOptions = { alignment: 5, marginV: 0 };

/**
 * Build a TikTok/CapCut-style caption file (.ass) for ONE output clip: bold
 * white words a few at a time, with the word being spoken right now in gold.
 *
 * `words` carry absolute source-video timestamps (exact from Whisper, or
 * estimated - see wordTiming.ts); `clipStart`/`clipEnd` are also absolute.
 * Output event times are shifted so 0 == clipStart, which is how ffmpeg's
 * `ass` filter will see time after the clip is trimmed out with
 * `-ss clipStart`.
 */
export function buildClipAss(
  words: TimedWord[],
  clipStart: number,
  clipEnd: number,
  style: AssStyleOptions = {},
): string {
  const fontSize = style.fontSize ?? 92;
  const marginV = style.marginV ?? 480;
  const alignment = style.alignment ?? 2;
  const clipLength = clipEnd - clipStart;

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,${CAPTION_FONT},${fontSize},${TEXT_COLOUR},${TEXT_COLOUR},${OUTLINE_COLOUR},${SHADOW_COLOUR},0,0,0,0,100,100,0,0,1,7,3,${alignment},90,90,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const visible = words
    .filter((w) => w.end > clipStart && w.start < clipEnd)
    .map((w) => ({
      text: escapeAssText(w.text),
      seg: w.seg,
      start: Math.max(w.start, clipStart) - clipStart,
      end: Math.min(w.end, clipEnd) - clipStart,
    }));

  const shown: CaptionWord[] = visible.map((w, i) => {
    const next = visible[i + 1];
    const until =
      next && next.start - w.end <= MAX_HOLD
        ? next.start
        : Math.min(w.end + TAIL_HOLD, next ? next.start : clipLength);
    return { text: w.text, seg: w.seg, start: w.start, until: Math.max(until, w.end) };
  });

  // Group by transcript segment so a page never runs across two sentences.
  const groups: CaptionWord[][] = [];
  for (const word of shown) {
    const group = groups[groups.length - 1];
    if (group && group[0].seg === word.seg) group.push(word);
    else groups.push([word]);
  }

  const lines: string[] = [];
  for (const page of groups.flatMap(paginate)) {
    // One event per word: the whole page is on screen, the active word is
    // gold. Every event has the same words, so line wrapping never jumps.
    page.forEach((word, i) => {
      if (word.until - word.start < 0.01) return;
      const text = page
        .map((w, j) => (j === i ? `${HIGHLIGHT_TAG}${w.text}{\\r}` : w.text))
        .join(' ');
      lines.push(
        `Dialogue: 0,${formatAssTime(word.start)},${formatAssTime(word.until)},Caption,,0,0,0,,${text}`,
      );
    });
  }

  return header + lines.join('\n') + '\n';
}

export function writeClipAss(
  words: TimedWord[],
  clipStart: number,
  clipEnd: number,
  outPath: string,
  style?: AssStyleOptions,
): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buildClipAss(words, clipStart, clipEnd, style), 'utf-8');
}
