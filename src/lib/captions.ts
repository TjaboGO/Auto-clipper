import fs from 'fs';
import path from 'path';
import type { TranscriptSegment } from './types';

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

interface TimedWord {
  text: string;
  start: number;
  end: number;
}

/**
 * Split a segment's time across its words. Gemini gives segment-level (not
 * word-perfect) timestamps, so each word gets a share of the segment that
 * grows with its length - longer words take longer to say. A deliberate,
 * documented approximation, not forced alignment against the audio.
 */
function timeWords(words: string[], start: number, end: number): TimedWord[] {
  const weights = words.map((w) => w.length + 2);
  const total = weights.reduce((a, b) => a + b, 0);
  const timed: TimedWord[] = [];
  let cursor = start;
  words.forEach((text, i) => {
    const wordEnd = i === words.length - 1 ? end : cursor + ((end - start) * weights[i]) / total;
    timed.push({ text, start: cursor, end: wordEnd });
    cursor = wordEnd;
  });
  return timed;
}

function pageChars(page: TimedWord[]): number {
  return page.reduce((sum, w) => sum + w.text.length, 0) + Math.max(0, page.length - 1);
}

function paginate(words: TimedWord[]): TimedWord[][] {
  const pages: TimedWord[][] = [];
  let page: TimedWord[] = [];
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
}

/**
 * Build a TikTok/CapCut-style caption file (.ass) for ONE output clip: bold
 * white words a few at a time, with the word being spoken right now in gold.
 *
 * `transcript` uses absolute source-video timestamps (as returned by
 * Gemini); `clipStart`/`clipEnd` are also absolute. Output event times are
 * shifted so 0 == clipStart, which is how ffmpeg's `ass` filter will see
 * time after the clip is trimmed out with `-ss clipStart`.
 */
export function buildClipAss(
  transcript: TranscriptSegment[],
  clipStart: number,
  clipEnd: number,
  style: AssStyleOptions = {},
): string {
  const fontSize = style.fontSize ?? 92;
  const marginV = style.marginV ?? 480;

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,${CAPTION_FONT},${fontSize},${TEXT_COLOUR},${TEXT_COLOUR},${OUTLINE_COLOUR},${SHADOW_COLOUR},0,0,0,0,100,100,0,0,1,7,3,2,90,90,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const lines: string[] = [];
  for (const seg of transcript) {
    if (seg.end <= clipStart || seg.start >= clipEnd) continue;
    const words = seg.text.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;

    // Time words over the whole segment first, then keep the part that falls
    // inside the clip, so a segment cut by the clip edge keeps its pacing.
    const visible = timeWords(words, seg.start, seg.end)
      .filter((w) => w.end > clipStart && w.start < clipEnd)
      .map((w) => ({
        text: escapeAssText(w.text),
        start: Math.max(w.start, clipStart) - clipStart,
        end: Math.min(w.end, clipEnd) - clipStart,
      }));

    for (const page of paginate(visible)) {
      // One event per word: the whole page is on screen, the active word is
      // gold. Every event has the same words, so line wrapping never jumps.
      page.forEach((word, i) => {
        if (word.end - word.start < 0.01) return;
        const text = page
          .map((w, j) => (j === i ? `${HIGHLIGHT_TAG}${w.text}{\\r}` : w.text))
          .join(' ');
        lines.push(
          `Dialogue: 0,${formatAssTime(word.start)},${formatAssTime(word.end)},Caption,,0,0,0,,${text}`,
        );
      });
    }
  }

  return header + lines.join('\n') + '\n';
}

export function writeClipAss(
  transcript: TranscriptSegment[],
  clipStart: number,
  clipEnd: number,
  outPath: string,
  style?: AssStyleOptions,
): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buildClipAss(transcript, clipStart, clipEnd, style), 'utf-8');
}
