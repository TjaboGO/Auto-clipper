import {
  captionMetrics,
  captionPages,
  pageScale,
  titleMetrics,
  wordColor,
  type CaptionMetrics,
  type CaptionPage,
} from './edit/captionLayout';
import type { OutputSize, ResolvedLayout } from './edit/layout';
import type { OutputWord } from './edit/timeline';
import type { AspectRatio, CaptionSettings, TitleSettings } from './edit/types';

/** Escape a filesystem path for use as an ffmpeg filtergraph option value. */
export function escapeFfmpegFilterPath(p: string): string {
  return p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

// Caption fonts ship in assets/fonts and are handed to libass via the ass
// filter's `fontsdir`, so captions look the same on every machine instead of
// depending on whatever fonts the server happens to have.

const OUTLINE_COLOUR = '&H00000000'; // black
const SHADOW_COLOUR = '&H80000000'; // half-transparent black

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
  // \N - neutralize both so spoken text can't break the tags we insert. A
  // line break would end the event line, so those become spaces.
  return text
    .replace(/\\/g, '/')
    .replace(/\{/g, '(')
    .replace(/\}/g, ')')
    .replace(/[\r\n]+/g, ' ');
}

/** #rrggbb as an ASS style colour (&HAABBGGRR). */
function styleColour(hex: string, alpha = '00'): string {
  const [r, g, b] = [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)];
  return `&H${alpha}${b}${g}${r}`.toUpperCase();
}

/** #rrggbb as an inline \c colour (&HBBGGRR&). */
function inlineColour(hex: string): string {
  const [r, g, b] = [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)];
  return `&H${b}${g}${r}&`.toUpperCase();
}

const n1 = (value: number) => String(Math.round(value * 10) / 10);

/** A page's text with each word in its colour, word `active` the one being said. */
function pageText(
  page: CaptionPage,
  active: number,
  settings: CaptionSettings,
  metrics: CaptionMetrics,
): string {
  let current = settings.textColor;
  return page
    .map((word, i) => {
      const colour = wordColor(settings, word, i === active);
      const grow = i === active && metrics.activeScale !== 1;
      let tags = '';
      if (colour !== current) {
        tags += `\\c${inlineColour(colour)}`;
        current = colour;
      }
      if (grow) tags += `\\fscx${Math.round(metrics.activeScale * 100)}\\fscy${Math.round(metrics.activeScale * 100)}`;
      return `${tags ? `{${tags}}` : ''}${escapeAssText(word.text)}${grow ? '{\\fscx100\\fscy100}' : ''}`;
    })
    .join(' ');
}

/** Box style, bottom layer: the same text, invisible except a box behind word `active`. */
function boxText(page: CaptionPage, active: number): string {
  return page
    .map((word, i) => (i === active ? `{\\3a&H00&}${escapeAssText(word.text)}{\\3a&HFF&}` : escapeAssText(word.text)))
    .join(' ');
}

export interface ClipAssOptions {
  /** Caption words on the finished clip's timeline (see outputWords). */
  words: OutputWord[];
  clipLength: number;
  captions: CaptionSettings;
  title: TitleSettings;
  out: OutputSize;
  layout: ResolvedLayout;
  aspect: AspectRatio;
}

/**
 * Build the .ass subtitle file for one finished clip: TikTok/CapCut-style
 * captions a few words at a time with the word being said highlighted (in
 * the chosen style), plus the optional title at the top. Times are on the
 * clip's own timeline, which is what ffmpeg's `ass` filter sees after the
 * cuts.
 */
export function buildClipAss(opts: ClipAssOptions): string {
  const { words, clipLength, captions, title, out, layout, aspect } = opts;
  const m = captionMetrics(captions, out, layout, aspect);
  const t = titleMetrics(captions, title.duration, out, aspect, clipLength);
  const text = styleColour(captions.textColor);

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${out.w}
PlayResY: ${out.h}
ScaledBorderAndShadow: yes
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,${m.font.family},${n1(m.fontSize)},${text},${text},${OUTLINE_COLOUR},${SHADOW_COLOUR},0,0,0,0,100,100,0,0,1,${n1(m.outline)},${n1(m.shadow)},5,${Math.round(m.marginX)},${Math.round(m.marginX)},0,1
Style: Box,${m.font.family},${n1(m.fontSize)},${text},${text},${styleColour(captions.highlightColor)},${styleColour(captions.highlightColor)},0,0,0,0,100,100,0,0,3,${n1(m.boxPad)},0,5,${Math.round(m.marginX)},${Math.round(m.marginX)},0,1
Style: Title,${t.font.family},${n1(t.fontSize)},&H00141414,&H00141414,&H00FFFFFF,&H00000000,0,0,0,0,100,100,0,0,3,${n1(t.boxPad)},0,8,${Math.round(t.marginX)},${Math.round(t.marginX)},0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const lines: string[] = [];
  const dialogue = (layer: number, start: number, end: number, style: string, body: string) =>
    lines.push(`Dialogue: ${layer},${formatAssTime(start)},${formatAssTime(end)},${style},,0,0,0,,${body}`);
  const pos = `\\an5\\pos(${n1(m.centerX)},${n1(m.centerY)})`;

  if (captions.enabled) {
    const pages = captionPages(words, clipLength, {
      maxWords: m.maxWords,
      maxChars: m.maxChars,
      uppercase: captions.uppercase,
    });
    for (const page of pages) {
      // A single word too long for the frame is shrunk to fit.
      const fit = pageScale(page, m.maxChars);
      const pct = (scale: number) => Math.round(scale * fit * 100);
      const fitTags = fit < 1 ? `\\fscx${pct(1)}\\fscy${pct(1)}` : '';
      if (captions.preset === 'clean') {
        // Nothing changes from word to word: one event for the whole page.
        dialogue(1, page[0].start, page[page.length - 1].until, 'Caption', `{${pos}${fitTags}}${pageText(page, -1, captions, m)}`);
        continue;
      }
      // One event per word: the whole page is on screen, the active word
      // stands out. Every event has the same words, so wrapping never jumps.
      page.forEach((word, i) => {
        if (word.until - word.start < 0.01) return;
        if (captions.preset === 'word') {
          const from = pct(m.popFrom);
          const pop = `\\fscx${from}\\fscy${from}\\t(0,100,\\fscx${pct(1)}\\fscy${pct(1)})`;
          dialogue(1, word.start, word.until, 'Caption', `{${pos}${pop}}${pageText(page, i, captions, m)}`);
          return;
        }
        if (captions.preset === 'box') {
          dialogue(0, word.start, word.until, 'Box', `{${pos}${fitTags}\\1a&HFF&\\3a&HFF&\\4a&HFF&}${boxText(page, i)}`);
        }
        dialogue(1, word.start, word.until, 'Caption', `{${pos}${fitTags}}${pageText(page, i, captions, m)}`);
      });
    }
  }

  if (title.enabled && title.text.trim()) {
    dialogue(2, 0, t.until, 'Title', `{\\an8\\pos(${n1(t.centerX)},${n1(t.top)})}${escapeAssText(title.text.trim())}`);
  }

  return header + lines.join('\n') + '\n';
}
