// "Mall från video": what Gemini says about how a video is edited, turned
// into one of our templates. Every setting Gemini picks comes from our own
// lists; anything the app can't do (yet) becomes a note instead, so you
// know what's missing. Plain functions, no Node.
import { captionFont, isCustomFontId } from './fonts';
import { CAPTION_PRESETS, DEFAULT_LOGO, presetCaptions } from './presets';
import { CUT_TRANSITIONS, ZOOM_LEVELS, type CutTransition, type ZoomLevel } from './zoom';
import type { BrandStyle, CaptionPresetId, StyleOrigin } from './types';

/** Gemini's answer (see videoStyleSchema in gemini.ts). */
export interface VideoStyleAnalysis {
  name: string;
  summary: string;
  aspect: string;
  layout: string;
  captions_shown: boolean;
  caption_preset: string;
  caption_font: string;
  caption_uppercase: boolean;
  caption_words: number;
  caption_size: string;
  caption_position: string;
  text_color: string;
  highlight_color: string;
  emphasis_color: string;
  emojis: string;
  hook_title: string;
  fillers_removed: boolean;
  pauses_removed: boolean;
  zoom_level: string;
  zoom_style: string;
  cut_transition: string;
  cut_transition_other: string;
  broll: string;
  music: boolean;
  music_mood: string;
  music_volume: string;
  sound_effects: string[];
  progress_bar: boolean;
  progress_color: string;
  progress_position: string;
  other_effects: string[];
}

export const VIDEO_STYLE_CHOICES = {
  aspect: ['9:16', '1:1', '4:5', '16:9'],
  layout: ['follow_speaker', 'full_frame', 'split_two', 'facecam_game', 'screen_face', 'group'],
  captionSize: ['small', 'medium', 'large'],
  captionPosition: ['top', 'middle', 'lower_third', 'bottom'],
  emojis: ['none', 'rare', 'often'],
  hookTitle: ['none', 'first_seconds', 'whole_clip'],
  zoomStyle: ['smooth', 'cut'],
  cutTransition: ['none', 'punch_zoom', 'flash', 'other'],
  broll: ['never', 'rare', 'often'],
  musicVolume: ['low', 'medium', 'high'],
  progressPosition: ['top', 'bottom'],
} as const;

const LAYOUT_LABELS: Record<string, string> = {
  follow_speaker: 'Följ talaren',
  full_frame: 'Hela bilden',
  split_two: 'Split screen',
  facecam_game: 'Spel med facecam',
  screen_face: 'Skärm med ansikte',
  group: 'Grupp',
};

const VOLUME_LABELS: Record<string, string> = { low: 'låg', medium: 'mellan', high: 'hög' };

const SIZES: Record<string, number> = { small: 0.85, medium: 1, large: 1.15 };
/** Where the captions sit (a share of the frame height), or null for the app's own choice. */
const POSITIONS: Record<string, number | null> = { top: 0.22, middle: 0.5, lower_third: null, bottom: 0.78 };

const MAX_NAME = 40;
const MAX_SUMMARY = 800;
const MAX_NOTE = 300;
const MAX_NOTES = 12;

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function list(value: unknown, max = 8): string[] {
  return (Array.isArray(value) ? value : []).map((v) => text(v, 120)).filter(Boolean).slice(0, max);
}

function hex(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim().toUpperCase() : fallback;
}

function pick<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return options.includes(value as T) ? (value as T) : fallback;
}

/**
 * Gemini's description of a video's editing, as a template: the style, a
 * name, and notes on what to do by hand or what the app can't do yet.
 */
export function styleFromAnalysis(
  raw: unknown,
  from: string,
): { name: string; style: Omit<BrandStyle, 'savedAt'>; origin: StyleOrigin } {
  const a = (raw && typeof raw === 'object' ? raw : {}) as Partial<VideoStyleAnalysis>;

  const preset = pick(a.caption_preset, CAPTION_PRESETS.map((p) => p.id), 'karaoke' as CaptionPresetId);
  const base = presetCaptions(preset);
  const font =
    typeof a.caption_font === 'string' && !isCustomFontId(a.caption_font) && captionFont(a.caption_font).id === a.caption_font
      ? captionFont(a.caption_font).id
      : base.font;
  const words = Number.isFinite(Number(a.caption_words)) ? Math.min(8, Math.max(1, Math.round(Number(a.caption_words)))) : base.maxWords;
  const emojis = pick(a.emojis, VIDEO_STYLE_CHOICES.emojis, 'none');
  const captions = {
    ...base,
    enabled: a.captions_shown !== false,
    font,
    uppercase: typeof a.caption_uppercase === 'boolean' ? a.caption_uppercase : base.uppercase,
    maxWords: words,
    size: SIZES[pick(a.caption_size, VIDEO_STYLE_CHOICES.captionSize, 'medium')],
    position: POSITIONS[pick(a.caption_position, VIDEO_STYLE_CHOICES.captionPosition, 'lower_third')],
    textColor: hex(a.text_color, base.textColor),
    highlightColor: hex(a.highlight_color, base.highlightColor),
    emphasisColor: hex(a.emphasis_color, base.emphasisColor),
    emojis: emojis !== 'none',
  };

  const hook = pick(a.hook_title, VIDEO_STYLE_CHOICES.hookTitle, 'none');
  const zoom = pick(a.zoom_level, ZOOM_LEVELS.map((z) => z.id), 'off' as ZoomLevel);
  const cut = pick(a.cut_transition, VIDEO_STYLE_CHOICES.cutTransition, 'none');
  const transition: CutTransition = cut === 'punch_zoom' ? 'punch' : cut === 'flash' ? 'flash' : 'none';
  const style: Omit<BrandStyle, 'savedAt'> = {
    captions,
    title: { enabled: hook !== 'none', duration: hook === 'whole_clip' ? 'all' : 'intro' },
    logo: DEFAULT_LOGO,
    zoom,
    zoomStyle: pick(a.zoom_style, VIDEO_STYLE_CHOICES.zoomStyle, 'smooth'),
    transition: CUT_TRANSITIONS.some((c) => c.id === transition) ? transition : 'none',
    progress: {
      enabled: a.progress_bar === true,
      color: hex(a.progress_color, '#FFFFFF'),
      position: pick(a.progress_position, VIDEO_STYLE_CHOICES.progressPosition, 'bottom'),
    },
    removeFillers: a.fillers_removed === true,
    removePauses: a.pauses_removed === true,
  };

  // What to do by hand, and what the app can't do (yet).
  const notes: string[] = [];
  const aspect = pick(a.aspect, VIDEO_STYLE_CHOICES.aspect, '9:16');
  notes.push(`Formatet är ${aspect}. Välj det när du skapar klipp.`);
  const layout = pick(a.layout, VIDEO_STYLE_CHOICES.layout, 'follow_speaker');
  if (layout !== 'follow_speaker') {
    notes.push(`Layouten är ${LAYOUT_LABELS[layout]}. Appen väljer layout själv, men du kan ändra den i redigeraren.`);
  }
  const broll = pick(a.broll, VIDEO_STYLE_CHOICES.broll, 'never');
  if (broll !== 'never') {
    notes.push(`Videon visar B-roll ${broll === 'often' ? 'ofta' : 'ibland'}. Kryssa i B-roll när du skapar klipp.`);
  }
  if (a.music === true) {
    const mood = text(a.music_mood, 80);
    const volume = VOLUME_LABELS[pick(a.music_volume, VIDEO_STYLE_CHOICES.musicVolume, 'low')];
    notes.push(`Musik${mood ? `: ${mood}` : ''}, ${volume} volym. Välj en egen låt i den stämningen under Musik.`);
  }
  const sounds = list(a.sound_effects);
  if (sounds.length) notes.push(`Ljudeffekter (${sounds.join(', ')}) kan appen inte lägga in än.`);
  if (cut === 'other') {
    const other = text(a.cut_transition_other, 80);
    notes.push(`Övergången vid klippen${other ? ` (${other})` : ''} finns inte i appen än. Mallen använder ingen övergång.`);
  }
  for (const effect of list(a.other_effects)) notes.push(`Kan inte göras än: ${effect}`);

  const name = text(a.name, MAX_NAME) || 'Stil från video';
  return {
    name,
    style,
    origin: {
      kind: 'video',
      from: text(from, 200) || 'en video',
      summary: text(a.summary, MAX_SUMMARY),
      notes: notes.map((n) => n.slice(0, MAX_NOTE)).slice(0, MAX_NOTES),
    },
  };
}

/** A name that isn't taken yet: "Name", "Name 2", "Name 3" ... */
export function uniqueName(name: string, taken: string[]): string {
  const used = new Set(taken.map((t) => t.toLowerCase()));
  if (!used.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) {
    const candidate = `${name.slice(0, MAX_NAME - 3)} ${i}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}
