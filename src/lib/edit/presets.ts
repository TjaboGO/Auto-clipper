import { allFonts } from './fonts';
import { PANEL_SIZE_RANGE } from './layout';
import { captionLanguage } from './translation';
import { knownEmoji } from './emoji';
import { CUT_TRANSITIONS, ZOOM_LEVELS, ZOOM_STYLES, type ZoomLevel } from './zoom';
import type {
  AspectRatio,
  BrandStyle,
  CaptionPresetId,
  CaptionTranslation,
  ClipMusic,
  BrollItem,
  BrollVideo,
  CaptionSettings,
  ClipEdit,
  LayoutMode,
  LogoCorner,
  LogoSettings,
  ProgressBarSettings,
  ReframeKey,
  TimeRange,
  WordOverride,
} from './types';

export interface CaptionPreset {
  id: CaptionPresetId;
  label: string;
  description: string;
  /** What picking the preset sets (position and on/off are kept). */
  style: Omit<CaptionSettings, 'enabled' | 'preset' | 'position' | 'emphasisColor' | 'emojis'>;
  /** Whether the highlight colour does anything in this preset. */
  usesHighlight: boolean;
}

export const CAPTION_PRESETS: CaptionPreset[] = [
  {
    id: 'karaoke',
    label: 'Karaoke',
    description: 'Några ord i taget, ordet som sägs lyser',
    style: { font: 'montserrat', size: 1, textColor: '#FFFFFF', highlightColor: '#FFD700', uppercase: false, maxWords: 5 },
    usesHighlight: true,
  },
  {
    id: 'box',
    label: 'Box',
    description: 'Färgad ruta bakom ordet som sägs',
    style: { font: 'montserrat', size: 1, textColor: '#FFFFFF', highlightColor: '#7C5CFF', uppercase: false, maxWords: 4 },
    usesHighlight: true,
  },
  {
    id: 'pop',
    label: 'Pop',
    description: 'Stora versaler, ordet som sägs växer',
    style: { font: 'anton', size: 1.1, textColor: '#FFFFFF', highlightColor: '#FFE14D', uppercase: true, maxWords: 3 },
    usesHighlight: true,
  },
  {
    id: 'word',
    label: 'Ord för ord',
    description: 'Ett ord i taget, stort',
    style: { font: 'bangers', size: 1, textColor: '#FFFFFF', highlightColor: '#FFD700', uppercase: true, maxWords: 1 },
    usesHighlight: false,
  },
  {
    id: 'clean',
    label: 'Enkel',
    description: 'Vanlig text utan effekter',
    style: { font: 'poppins', size: 0.85, textColor: '#FFFFFF', highlightColor: '#FFFFFF', uppercase: false, maxWords: 6 },
    usesHighlight: false,
  },
  {
    id: 'bounce',
    label: 'Studs',
    description: 'Texten studsar in, ordet som sägs lyser',
    style: { font: 'lilita', size: 1.05, textColor: '#FFFFFF', highlightColor: '#FFD23F', uppercase: true, maxWords: 3 },
    usesHighlight: true,
  },
  {
    id: 'reveal',
    label: 'Fram ord för ord',
    description: 'Orden dyker upp när de sägs',
    style: { font: 'montserrat', size: 1, textColor: '#FFFFFF', highlightColor: '#4ADE80', uppercase: true, maxWords: 4 },
    usesHighlight: true,
  },
  {
    id: 'neon',
    label: 'Neon',
    description: 'Texten lyser i din färg',
    style: { font: 'kanit', size: 1, textColor: '#FFFFFF', highlightColor: '#00E5FF', uppercase: true, maxWords: 4 },
    usesHighlight: true,
  },
];

export function captionPreset(id: string): CaptionPreset {
  return CAPTION_PRESETS.find((p) => p.id === id) ?? CAPTION_PRESETS[0];
}

export const DEFAULT_EMPHASIS_COLOR = '#4ADE80';

export function presetCaptions(id: CaptionPresetId, keep?: Partial<CaptionSettings>): CaptionSettings {
  const preset = captionPreset(id);
  return {
    enabled: keep?.enabled ?? true,
    preset: preset.id,
    position: keep?.position ?? null,
    emphasisColor: keep?.emphasisColor ?? DEFAULT_EMPHASIS_COLOR,
    emojis: keep?.emojis ?? true,
    ...preset.style,
  };
}

export const ASPECT_RATIOS: AspectRatio[] = ['9:16', '1:1', '4:5', '16:9'];
export const LOGO_CORNERS: LogoCorner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
export const DEFAULT_LOGO: LogoSettings = { enabled: false, corner: 'top-right', size: 0.16, opacity: 1 };
export const LAYOUT_MODES: LayoutMode[] = ['auto', 'fill', 'fit', 'split', 'facecam', 'screen', 'group'];
export const DEFAULT_PROGRESS: ProgressBarSettings = { enabled: false, color: '#FFD400', position: 'bottom' };

/** How the pipeline renders a fresh clip: no cuts, auto framing, the job's format and caption style. */
export function defaultEdit(opts: {
  start: number;
  end: number;
  title: string;
  aspect?: AspectRatio;
  captionPreset?: CaptionPresetId;
  zoom?: ZoomLevel;
  music?: ClipMusic | null;
}): ClipEdit {
  return {
    v: 1,
    start: opts.start,
    end: opts.end,
    deleted: [],
    removeFillers: false,
    removePauses: false,
    words: {},
    captions: presetCaptions(opts.captionPreset ?? 'karaoke'),
    title: { enabled: false, text: opts.title, duration: 'intro' },
    aspect: opts.aspect ?? '9:16',
    layout: 'auto',
    splitSwap: false,
    panelSize: null,
    reframe: [],
    logo: { ...DEFAULT_LOGO },
    translation: null,
    zoom: opts.zoom ?? 'off',
    music: opts.music ?? null,
    broll: [],
    progress: { ...DEFAULT_PROGRESS },
    zoomStyle: 'smooth',
    transition: 'none',
  };
}

export const MIN_CLIP_SECONDS = 1;
const MAX_WORD_TEXT = 60;
const MAX_TITLE_TEXT = 120;
const MAX_REFRAME_KEYS = 200;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function color(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : fallback;
}

function oneOf<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return options.includes(value as T) ? (value as T) : fallback;
}

function text(value: unknown, max: number, fallback: string): string {
  return typeof value === 'string' ? value.replace(/[\r\n\t]+/g, ' ').slice(0, max) : fallback;
}

function sanitizeCaptions(raw: unknown, fallback: CaptionSettings): CaptionSettings {
  if (!isObject(raw)) return fallback;
  const preset = oneOf(raw.preset, CAPTION_PRESETS.map((p) => p.id), fallback.preset);
  return {
    enabled: bool(raw.enabled, fallback.enabled),
    preset,
    font: oneOf(raw.font, allFonts().map((f) => f.id), fallback.font),
    size: num(raw.size, 0.5, 2, fallback.size),
    position: raw.position === null ? null : num(raw.position, 0.05, 0.95, fallback.position ?? 0.72),
    textColor: color(raw.textColor, fallback.textColor),
    highlightColor: color(raw.highlightColor, fallback.highlightColor),
    emphasisColor: color(raw.emphasisColor, fallback.emphasisColor),
    uppercase: bool(raw.uppercase, fallback.uppercase),
    maxWords: Math.round(num(raw.maxWords, 1, 8, fallback.maxWords)),
    emojis: bool(raw.emojis, fallback.emojis ?? true),
  };
}

export function sanitizeProgress(raw: unknown, fallback: ProgressBarSettings): ProgressBarSettings {
  if (!isObject(raw)) return fallback;
  return {
    enabled: bool(raw.enabled, fallback.enabled),
    color: color(raw.color, fallback.color),
    position: oneOf(raw.position, ['top', 'bottom'] as const, fallback.position),
  };
}

export function sanitizeLogo(raw: unknown, fallback: LogoSettings): LogoSettings {
  if (!isObject(raw)) return fallback;
  return {
    enabled: bool(raw.enabled, fallback.enabled),
    corner: oneOf(raw.corner, LOGO_CORNERS, fallback.corner),
    size: num(raw.size, 0.06, 0.4, fallback.size),
    opacity: num(raw.opacity, 0.2, 1, fallback.opacity),
  };
}

/** An edit saved before a setting existed gets that setting's default. */
export function upgradeEdit(edit: ClipEdit): ClipEdit {
  return {
    ...edit,
    captions: { ...edit.captions, emojis: edit.captions.emojis ?? true },
    logo: sanitizeLogo(edit.logo, DEFAULT_LOGO),
    panelSize: panelSize(edit.panelSize, null),
    translation: sanitizeTranslation(edit.translation, null),
    zoom: oneOf(edit.zoom, ZOOM_LEVELS.map((l) => l.id), 'off'),
    music: sanitizeMusic(edit.music, null),
    broll: sanitizeBroll(edit.broll, []),
    progress: sanitizeProgress(edit.progress, DEFAULT_PROGRESS),
    // Clips from before smooth zoom keep jumping, so a new render looks the same.
    zoomStyle: oneOf(edit.zoomStyle, ZOOM_STYLES.map((z) => z.id), 'cut'),
    transition: oneOf(edit.transition, CUT_TRANSITIONS.map((c) => c.id), 'none'),
  };
}

export const BROLL_DURATION = { min: 1, max: 8, default: 3 };
const MAX_BROLL = 12;

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

/** One Pexels result, checked (null if it isn't one). */
export function sanitizeBrollVideo(raw: unknown): BrollVideo | null {
  if (!isObject(raw) || typeof raw.id !== 'string') return null;
  const id = /^pexels-(\d{1,15})$/.exec(raw.id)?.[1];
  const https = (v: unknown) => (typeof v === 'string' && /^https?:\/\//.test(v) ? v.slice(0, 500) : '');
  if (!id || raw.file !== `pexels-${id}.mp4` || !https(raw.download)) return null;
  return {
    id: raw.id,
    file: raw.file,
    width: Math.round(num(raw.width, 16, 8192, 1080)),
    height: Math.round(num(raw.height, 16, 8192, 1920)),
    duration: num(raw.duration, 1, 3600, 10),
    thumb: https(raw.thumb),
    author: str(raw.author, 80) || 'Pexels',
    authorUrl: https(raw.authorUrl) || 'https://www.pexels.com',
    pageUrl: https(raw.pageUrl) || 'https://www.pexels.com',
    download: https(raw.download),
  };
}

/** B-roll as sent from the editor: known videos on words, durations within limits. */
export function sanitizeBroll(value: unknown, fallback: BrollItem[], wordIds?: Set<string>): BrollItem[] {
  if (!Array.isArray(value)) return fallback;
  const items: BrollItem[] = [];
  for (const raw of value.slice(0, MAX_BROLL)) {
    if (!isObject(raw) || typeof raw.wordId !== 'string' || (wordIds && !wordIds.has(raw.wordId))) continue;
    const video = sanitizeBrollVideo(raw.video);
    if (!video) continue;
    items.push({
      video,
      wordId: raw.wordId,
      duration: num(raw.duration, BROLL_DURATION.min, BROLL_DURATION.max, BROLL_DURATION.default),
      query: str(raw.query, 100),
    });
  }
  return items;
}

export const DEFAULT_MUSIC_VOLUME = 0.3;

/** Background music as sent from the editor: one of your tracks (by id) and a volume. */
export function sanitizeMusic(value: unknown, fallback: ClipMusic | null): ClipMusic | null {
  if (value === null) return null;
  if (!isObject(value) || typeof value.track !== 'string' || !/^m-[0-9a-f]{6,40}$/.test(value.track)) return fallback;
  return { track: value.track, volume: num(value.volume, 0.05, 1, DEFAULT_MUSIC_VOLUME) };
}

const MAX_TRANSLATED_SEGMENTS = 400;
const MAX_TRANSLATED_TEXT = 600;

/** Translated captions as sent from the editor: a known language and text per sentence index. */
export function sanitizeTranslation(value: unknown, fallback: CaptionTranslation | null): CaptionTranslation | null {
  if (value === null) return null;
  if (!isObject(value) || !captionLanguage(typeof value.lang === 'string' ? value.lang : null) || !isObject(value.segments)) {
    return fallback;
  }
  const segments: Record<string, string> = {};
  for (const [key, text] of Object.entries(value.segments).slice(0, MAX_TRANSLATED_SEGMENTS)) {
    if (/^\d+$/.test(key) && typeof text === 'string' && text.trim()) {
      segments[key] = text.replace(/[\r\n\t]+/g, ' ').trim().slice(0, MAX_TRANSLATED_TEXT);
    }
  }
  return { lang: value.lang as string, segments };
}

/** Facecam / screen: the camera's or screen's share of the height, or null = automatic. */
function panelSize(value: unknown, fallback: number | null): number | null {
  if (value === null) return null;
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(PANEL_SIZE_RANGE.max, Math.max(PANEL_SIZE_RANGE.min, value))
    : fallback;
}

/**
 * The clip with a saved look on it (Min stil or a template): text, title
 * and logo (a logo only if there is one), and zoom and progress bar when
 * the look has them.
 */
export function withStyle(edit: ClipEdit, style: BrandStyle, hasLogo: boolean): ClipEdit {
  return {
    ...edit,
    captions: { ...style.captions },
    title: { ...edit.title, enabled: style.title.enabled, duration: style.title.duration },
    logo: { ...style.logo, enabled: style.logo.enabled && hasLogo },
    ...(style.zoom ? { zoom: style.zoom } : {}),
    ...(style.zoomStyle ? { zoomStyle: style.zoomStyle } : {}),
    ...(style.transition ? { transition: style.transition } : {}),
    ...(style.progress ? { progress: { ...style.progress } } : {}),
  };
}

/** The look of a clip, to save as Min stil or a template. */
export function styleOf(edit: ClipEdit): Omit<BrandStyle, 'savedAt'> {
  return {
    captions: edit.captions,
    title: { enabled: edit.title.enabled, duration: edit.title.duration },
    logo: edit.logo,
    zoom: edit.zoom,
    zoomStyle: edit.zoomStyle,
    transition: edit.transition,
    progress: edit.progress,
  };
}

/** Clean up "Min stil" as sent from the editor. Null if it isn't one. */
export function sanitizeStyle(raw: unknown): BrandStyle | null {
  if (!isObject(raw) || !isObject(raw.captions)) return null;
  const captions = sanitizeCaptions(raw.captions, presetCaptions('karaoke'));
  const rawTitle = isObject(raw.title) ? raw.title : {};
  return {
    captions,
    title: {
      enabled: bool(rawTitle.enabled, false),
      duration: oneOf(rawTitle.duration, ['intro', 'all'] as const, 'intro'),
    },
    logo: sanitizeLogo(raw.logo, DEFAULT_LOGO),
    ...(raw.zoom !== undefined ? { zoom: oneOf(raw.zoom, ZOOM_LEVELS.map((l) => l.id), 'off') } : {}),
    ...(isObject(raw.progress) ? { progress: sanitizeProgress(raw.progress, DEFAULT_PROGRESS) } : {}),
    ...(raw.zoomStyle !== undefined ? { zoomStyle: oneOf(raw.zoomStyle, ZOOM_STYLES.map((z) => z.id), 'smooth') } : {}),
    ...(raw.transition !== undefined ? { transition: oneOf(raw.transition, CUT_TRANSITIONS.map((c) => c.id), 'none') } : {}),
    savedAt: new Date().toISOString(),
  };
}

/**
 * Clean up an edit that came from the browser: keep what's valid, fall back
 * to `fallback` (the saved edit) for anything that isn't, and keep the clip
 * inside the editor's window.
 */
export function sanitizeEdit(
  raw: unknown,
  ctx: { window: TimeRange; wordIds: Set<string>; fallback: ClipEdit },
): ClipEdit {
  const { window, wordIds, fallback } = ctx;
  if (!isObject(raw)) return fallback;

  let start = num(raw.start, window.start, window.end, fallback.start);
  let end = num(raw.end, window.start, window.end, fallback.end);
  if (end - start < MIN_CLIP_SECONDS) {
    start = fallback.start;
    end = fallback.end;
  }

  const deleted = Array.isArray(raw.deleted)
    ? [...new Set(raw.deleted.filter((id): id is string => typeof id === 'string' && wordIds.has(id)))]
    : fallback.deleted;

  const words: Record<string, WordOverride> = {};
  const rawWords = isObject(raw.words) ? raw.words : fallback.words;
  for (const [id, value] of Object.entries(rawWords)) {
    if (!wordIds.has(id) || !isObject(value)) continue;
    const override: WordOverride = {};
    if (typeof value.text === 'string') override.text = text(value.text, MAX_WORD_TEXT, '').trim();
    if (value.hidden === true) override.hidden = true;
    if (value.emphasis === true) override.emphasis = true;
    const emoji = knownEmoji(value.emoji);
    if (emoji) override.emoji = emoji;
    if (Object.keys(override).length > 0) words[id] = override;
  }

  const rawTitle = isObject(raw.title) ? raw.title : {};
  const title = {
    enabled: bool(rawTitle.enabled, fallback.title.enabled),
    text: text(rawTitle.text, MAX_TITLE_TEXT, fallback.title.text),
    duration: oneOf(rawTitle.duration, ['intro', 'all'] as const, fallback.title.duration),
  };

  const reframe: ReframeKey[] = Array.isArray(raw.reframe)
    ? raw.reframe
        .filter(isObject)
        .filter((k) => typeof k.t === 'number' && Number.isFinite(k.t))
        .map((k) => ({
          t: num(k.t, window.start, window.end, window.start),
          cx: k.cx === null ? null : num(k.cx, 0, 1, 0.5),
        }))
        .sort((a, b) => a.t - b.t)
        .slice(0, MAX_REFRAME_KEYS)
    : fallback.reframe;

  return {
    v: 1,
    start,
    end,
    deleted,
    removeFillers: bool(raw.removeFillers, fallback.removeFillers),
    removePauses: bool(raw.removePauses, fallback.removePauses),
    words,
    captions: sanitizeCaptions(raw.captions, fallback.captions),
    title,
    aspect: oneOf(raw.aspect, ASPECT_RATIOS, fallback.aspect),
    layout: oneOf(raw.layout, LAYOUT_MODES, fallback.layout),
    splitSwap: bool(raw.splitSwap, fallback.splitSwap),
    panelSize: panelSize(raw.panelSize, fallback.panelSize ?? null),
    reframe,
    logo: sanitizeLogo(raw.logo, fallback.logo ?? DEFAULT_LOGO),
    translation: sanitizeTranslation(raw.translation, fallback.translation ?? null),
    zoom: oneOf(raw.zoom, ZOOM_LEVELS.map((l) => l.id), fallback.zoom ?? 'off'),
    music: sanitizeMusic(raw.music, fallback.music ?? null),
    broll: sanitizeBroll(raw.broll, fallback.broll ?? [], wordIds),
    progress: sanitizeProgress(raw.progress, fallback.progress ?? DEFAULT_PROGRESS),
    zoomStyle: oneOf(raw.zoomStyle, ZOOM_STYLES.map((z) => z.id), fallback.zoomStyle ?? 'cut'),
    transition: oneOf(raw.transition, CUT_TRANSITIONS.map((c) => c.id), fallback.transition ?? 'none'),
  };
}
