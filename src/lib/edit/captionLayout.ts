import { captionFont, type CaptionFont } from './fonts';
import { captionPreset } from './presets';
import type { OutputSize } from './layout';
import type { OutputWord } from './timeline';
import type { AspectRatio, CaptionSettings } from './types';

// Shared by the .ass writer (the real render) and the editor's live preview,
// so both break the text into the same pages at the same times.

// Between words the caption stays up (no flicker in the short gaps real
// speech has). Only a pause longer than MAX_HOLD clears it, after TAIL_HOLD.
const MAX_HOLD = 0.8;
const TAIL_HOLD = 0.3;

// Sizes at the default setting, on a 1080 px wide 9:16 frame.
const BASE_FONT_SIZE = 92;
const BASE_OUTLINE = 7;
const BASE_SHADOW = 3;
const BASE_SIDE_MARGIN = 90;
const BASE_PAGE_CHARS = 24;
const BASE_TITLE_SIZE = 62;
// "Ord för ord" shows one big word: this much bigger than the other styles.
const WORD_BY_WORD_SCALE = 2.2;

/** A caption word on screen from `start` until `until` (clip timeline). */
export interface PageWord {
  text: string;
  start: number;
  until: number;
  emphasis: boolean;
}

/** The words shown together. */
export type CaptionPage = PageWord[];

function pageChars(page: PageWord[]): number {
  return page.reduce((sum, w) => sum + w.text.length, 0) + Math.max(0, page.length - 1);
}

function paginate(words: PageWord[], maxWords: number, maxChars: number): CaptionPage[] {
  const pages: CaptionPage[] = [];
  let page: PageWord[] = [];
  for (const word of words) {
    const fits = page.length < maxWords && pageChars([...page, word]) <= maxChars;
    if (page.length > 0 && !fits) {
      pages.push(page);
      page = [];
    }
    page.push(word);
  }
  if (page.length > 0) pages.push(page);

  // Don't leave a single word alone on the last page if the page before can
  // spare one ("konsekvent arbete" + "varje dag", not "... varje" + "dag").
  if (pages.length >= 2 && maxWords >= 3) {
    const last = pages[pages.length - 1];
    const prev = pages[pages.length - 2];
    if (last.length === 1 && prev.length >= 3) {
      const moved = [prev[prev.length - 1], ...last];
      if (pageChars(moved) <= maxChars) {
        pages[pages.length - 2] = prev.slice(0, -1);
        pages[pages.length - 1] = moved;
      }
    }
  }
  return pages;
}

/**
 * Break the caption words into pages: a few words at a time, never across
 * two transcript sentences, each word shown until the next one starts
 * (short gaps) or shortly after it ends (real pauses).
 */
export function captionPages(
  words: OutputWord[],
  clipLength: number,
  opts: { maxWords: number; maxChars: number; uppercase: boolean },
): CaptionPage[] {
  const shown = words.map((w, i) => {
    const next = words[i + 1];
    const until =
      next && next.start - w.end <= MAX_HOLD
        ? next.start
        : Math.min(w.end + TAIL_HOLD, next ? next.start : clipLength);
    return {
      text: opts.uppercase ? w.text.toUpperCase() : w.text,
      start: w.start,
      until: Math.max(until, w.end),
      emphasis: w.emphasis,
      seg: w.seg,
    };
  });

  const groups: (typeof shown)[] = [];
  for (const word of shown) {
    const group = groups[groups.length - 1];
    if (group && group[0].seg === word.seg) group.push(word);
    else groups.push([word]);
  }
  return groups.flatMap((group) =>
    paginate(
      group.map(({ seg: _seg, ...word }) => word),
      opts.maxWords,
      opts.maxChars,
    ),
  );
}

/** Sizes and positions for drawing the captions, in output pixels. */
export interface CaptionMetrics {
  font: CaptionFont;
  fontSize: number; // ASS font size (the font's whole line height)
  outline: number;
  shadow: number;
  /** Box style: how far the box reaches around the word. */
  boxPad: number;
  centerX: number;
  centerY: number;
  /** Left/right margin the text wraps inside. */
  marginX: number;
  maxWords: number;
  maxChars: number;
  /** "Ord för ord": each word pops in from this scale. */
  popFrom: number;
  /** "Pop" and "Neon": the word being said grows to this scale. */
  activeScale: number;
  /** "Neon": how soft the glowing outline is (output px, 0 = no glow). */
  glow: number;
}

/** `autoY`: where the captions go unless the user moved them (see defaultCaptionPosition). */
export function captionMetrics(
  settings: CaptionSettings,
  out: OutputSize,
  autoY: number,
  aspect: AspectRatio,
): CaptionMetrics {
  const font = captionFont(settings.font);
  const wordByWord = settings.preset === 'word';
  const frameScale = (Math.min(out.w, out.h) / 1080) * (aspect === '16:9' ? 0.8 : 1);
  const fontSize =
    BASE_FONT_SIZE * settings.size * font.sizeFactor * frameScale * (wordByWord ? WORD_BY_WORD_SCALE : 1);
  const marginX = BASE_SIDE_MARGIN * (out.w / 1080);
  const relative = fontSize / BASE_FONT_SIZE;
  // A wide font fits fewer letters on a line, a narrow one more.
  const maxChars = Math.round(
    (BASE_PAGE_CHARS * ((out.w - 2 * marginX) / (1080 - 2 * BASE_SIDE_MARGIN))) / (relative * font.widthFactor),
  );
  const position = settings.position ?? autoY;
  return {
    font,
    fontSize,
    outline: BASE_OUTLINE * relative,
    shadow: BASE_SHADOW * relative,
    boxPad: 0.17 * fontSize,
    centerX: out.w / 2,
    centerY: position * out.h,
    marginX,
    maxWords: wordByWord ? 1 : settings.maxWords,
    maxChars: Math.max(6, Math.min(48, maxChars)),
    popFrom: 0.8,
    activeScale: settings.preset === 'pop' ? 1.15 : settings.preset === 'neon' ? 1.08 : 1,
    glow: settings.preset === 'neon' ? 0.09 * fontSize : 0,
  };
}

// "Studs": a page comes in small, overshoots and settles, in the first
// BOUNCE_SECONDS (or the first word's time, if that is shorter).
export const BOUNCE_SECONDS = 0.22;
const BOUNCE_FROM = 0.6;
const BOUNCE_PEAK = 1.12;
const BOUNCE_PEAK_AT = 0.55;

export function bounceDuration(page: CaptionPage): number {
  return Math.min(BOUNCE_SECONDS, Math.max(0.05, page[0].until - page[0].start));
}

/** The page's size `elapsed` seconds after it came on (1 = normal). Straight lines between the steps, like libass's \t. */
export function bounceScale(elapsed: number, duration: number): number {
  if (elapsed >= duration) return 1;
  const peakAt = BOUNCE_PEAK_AT * duration;
  if (elapsed < peakAt) return BOUNCE_FROM + ((BOUNCE_PEAK - BOUNCE_FROM) * Math.max(0, elapsed)) / peakAt;
  return BOUNCE_PEAK + ((1 - BOUNCE_PEAK) * (elapsed - peakAt)) / (duration - peakAt);
}

/** The ASS tags for the same bounce, scaled by `fit` (a long single word shrunk to fit). */
export function bounceTags(duration: number, fit: number): string {
  const pct = (s: number) => Math.round(s * fit * 100);
  const peak = Math.round(BOUNCE_PEAK_AT * duration * 1000);
  const end = Math.round(duration * 1000);
  return (
    `\\fscx${pct(BOUNCE_FROM)}\\fscy${pct(BOUNCE_FROM)}` +
    `\\t(0,${peak},\\fscx${pct(BOUNCE_PEAK)}\\fscy${pct(BOUNCE_PEAK)})` +
    `\\t(${peak},${end},\\fscx${pct(1)}\\fscy${pct(1)})`
  );
}

/** "Fram ord för ord": words after the one being said aren't shown yet. */
export function wordVisible(settings: CaptionSettings, i: number, active: number): boolean {
  return settings.preset !== 'reveal' || active < 0 || i <= active;
}

/**
 * How much to shrink a page so it fits across the frame: only a page of
 * one word can be too wide (longer pages wrap onto more lines).
 */
export function pageScale(page: CaptionPage, maxChars: number): number {
  return page.length === 1 ? Math.min(1, maxChars / Math.max(1, page[0].text.length)) : 1;
}

/** Which colour each word of a page gets while word `active` is being said. */
export function wordColor(
  settings: CaptionSettings,
  word: PageWord,
  isActive: boolean,
): string {
  // Box and Neon use the colour for the box and the glow; the word itself stays as it is.
  if (isActive && settings.preset !== 'box' && settings.preset !== 'neon' && captionPreset(settings.preset).usesHighlight) {
    return settings.highlightColor;
  }
  return word.emphasis ? settings.emphasisColor : settings.textColor;
}

export interface TitleMetrics {
  font: CaptionFont;
  fontSize: number;
  boxPad: number;
  centerX: number;
  top: number;
  marginX: number;
  /** Seconds the title is on screen. */
  until: number;
}

export const TITLE_INTRO_SECONDS = 3;

export function titleMetrics(
  settings: CaptionSettings,
  duration: 'intro' | 'all',
  out: OutputSize,
  aspect: AspectRatio,
  clipLength: number,
): TitleMetrics {
  const font = captionFont(settings.font);
  const frameScale = (Math.min(out.w, out.h) / 1080) * (aspect === '16:9' ? 0.8 : 1);
  const fontSize = BASE_TITLE_SIZE * font.sizeFactor * frameScale;
  return {
    font,
    fontSize,
    boxPad: 0.28 * fontSize,
    centerX: out.w / 2,
    top: out.h * (aspect === '9:16' ? 0.1 : 0.06),
    marginX: out.w * 0.1,
    until: duration === 'all' ? clipLength : Math.min(TITLE_INTRO_SECONDS, clipLength),
  };
}
