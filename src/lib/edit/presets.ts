import { CAPTION_FONTS } from './fonts';
import type {
  AspectRatio,
  CaptionPresetId,
  CaptionSettings,
  ClipEdit,
  LayoutMode,
  ReframeKey,
  TimeRange,
  WordOverride,
} from './types';

export interface CaptionPreset {
  id: CaptionPresetId;
  label: string;
  description: string;
  /** What picking the preset sets (position and on/off are kept). */
  style: Omit<CaptionSettings, 'enabled' | 'preset' | 'position' | 'emphasisColor'>;
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
    ...preset.style,
  };
}

export const ASPECT_RATIOS: AspectRatio[] = ['9:16', '1:1', '4:5', '16:9'];
export const LAYOUT_MODES: LayoutMode[] = ['auto', 'fill', 'fit', 'split'];

/** How the pipeline renders a fresh clip: no cuts, karaoke captions, auto framing. */
export function defaultEdit(opts: { start: number; end: number; title: string }): ClipEdit {
  return {
    v: 1,
    start: opts.start,
    end: opts.end,
    deleted: [],
    removeFillers: false,
    removePauses: false,
    words: {},
    captions: presetCaptions('karaoke'),
    title: { enabled: false, text: opts.title, duration: 'intro' },
    aspect: '9:16',
    layout: 'auto',
    splitSwap: false,
    reframe: [],
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
    font: oneOf(raw.font, CAPTION_FONTS.map((f) => f.id), fallback.font),
    size: num(raw.size, 0.5, 2, fallback.size),
    position: raw.position === null ? null : num(raw.position, 0.05, 0.95, fallback.position ?? 0.72),
    textColor: color(raw.textColor, fallback.textColor),
    highlightColor: color(raw.highlightColor, fallback.highlightColor),
    emphasisColor: color(raw.emphasisColor, fallback.emphasisColor),
    uppercase: bool(raw.uppercase, fallback.uppercase),
    maxWords: Math.round(num(raw.maxWords, 1, 8, fallback.maxWords)),
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
    reframe,
  };
}
