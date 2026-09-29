// What you can choose when starting a job (and when searching for more
// clips). Plain TypeScript: the upload form and the server share it.
import { ASPECT_RATIOS, CAPTION_PRESETS } from './edit/presets';
import type { AspectRatio, CaptionPresetId } from './edit/types';

export type ClipLengthId = 'auto' | 'short' | 'medium' | 'long' | 'xlong';

export interface ClipLength {
  id: ClipLengthId;
  label: string;
  hint: string;
  min: number; // seconds
  max: number;
}

export const CLIP_LENGTHS: ClipLength[] = [
  { id: 'auto', label: 'Auto', hint: '15-90 s', min: 15, max: 90 },
  { id: 'short', label: 'Kort', hint: '15-30 s', min: 15, max: 30 },
  { id: 'medium', label: 'Mellan', hint: '30-60 s', min: 30, max: 60 },
  { id: 'long', label: 'Lång', hint: '60-90 s', min: 60, max: 90 },
  { id: 'xlong', label: 'Extra lång', hint: '1,5-3 min', min: 90, max: 180 },
];

export function clipLength(id: string): ClipLength {
  return CLIP_LENGTHS.find((l) => l.id === id) ?? CLIP_LENGTHS[0];
}

export interface JobOptions {
  clipLength: ClipLengthId;
  /** Format and caption style the clips are rendered with (the editor can change them later). */
  aspect: AspectRatio;
  captionPreset: CaptionPresetId;
  /** Let the AI pick the key words of each clip and show them in the emphasis colour. */
  keywords: boolean;
  /** "Find moments about ...": empty = just the best moments. */
  topic: string;
  /** Only use this part of the video (seconds), or null for all of it. */
  range: { start: number; end: number } | null;
}

export const MAX_TOPIC_LENGTH = 200;
/** A range shorter than this can't hold a clip. */
export const MIN_RANGE_SECONDS = 10;

export function defaultJobOptions(): JobOptions {
  return { clipLength: 'auto', aspect: '9:16', captionPreset: 'karaoke', keywords: true, topic: '', range: null };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function time(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 24 * 3600 ? value : null;
}

export function sanitizeTopic(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, MAX_TOPIC_LENGTH) : '';
}

/** Keep what's valid, use the defaults for the rest. */
export function sanitizeJobOptions(raw: unknown): JobOptions {
  const defaults = defaultJobOptions();
  if (!isObject(raw)) return defaults;
  const pick = <T extends string>(value: unknown, options: readonly T[], fallback: T): T =>
    options.includes(value as T) ? (value as T) : fallback;

  let range: JobOptions['range'] = null;
  if (isObject(raw.range)) {
    const start = time(raw.range.start) ?? 0;
    const end = time(raw.range.end);
    if (end !== null && end - start >= MIN_RANGE_SECONDS) range = { start, end };
  }
  return {
    clipLength: pick(raw.clipLength, CLIP_LENGTHS.map((l) => l.id), defaults.clipLength),
    aspect: pick(raw.aspect, ASPECT_RATIOS, defaults.aspect),
    captionPreset: pick(raw.captionPreset, CAPTION_PRESETS.map((p) => p.id), defaults.captionPreset),
    keywords: typeof raw.keywords === 'boolean' ? raw.keywords : defaults.keywords,
    topic: sanitizeTopic(raw.topic),
    range,
  };
}

/** "1:05" or "65" (seconds) or "1:02:05" -> seconds; null if it isn't a time. */
export function parseTime(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (!/^\d+(:\d{1,2}){0,2}$/.test(trimmed)) return null;
  return trimmed.split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
}

/** 65 -> "1:05" */
export function formatClock(seconds: number): string {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`;
}
