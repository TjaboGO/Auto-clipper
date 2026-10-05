// Types for the clip editor. Everything in src/lib/edit is plain TypeScript
// without Node imports, so the browser (live preview) and the server (the
// real render) share the exact same logic.

import type { CustomFont } from './fonts';

export type AspectRatio = '9:16' | '1:1' | '4:5' | '16:9';

/**
 * How a clip is framed:
 *  - auto: follow the speaker, or split screen when two people take quick turns
 *  - fill: always follow one person (crop)
 *  - fit: the whole frame, with a blurred copy behind it
 *  - split: two people stacked, one on top and one below
 */
export type LayoutMode = 'auto' | 'fill' | 'fit' | 'split';

export type CaptionPresetId = 'karaoke' | 'box' | 'pop' | 'word' | 'clean';

/** A caption font that comes with the app (see edit/fonts.ts). */
export type BuiltInFontId =
  | 'montserrat'
  | 'anton'
  | 'bebas'
  | 'poppins'
  | 'archivo'
  | 'luckiest'
  | 'bangers'
  | 'titan'
  | 'marker'
  | 'inter'
  | 'rubik'
  | 'oswald'
  | 'barlow'
  | 'nunito'
  | 'fredoka'
  | 'lilita'
  | 'kanit'
  | 'caveat'
  | 'pacifico'
  | 'pixel';

/** A caption font: one that comes with the app, or one you uploaded ("u-" + its id). */
export type FontId = BuiltInFontId | `u-${string}`;

export interface CaptionSettings {
  enabled: boolean;
  preset: CaptionPresetId;
  font: FontId;
  /** Multiplies the normal caption size (1 = default). */
  size: number;
  /** Vertical center of the captions as a share of the frame height, or null = automatic. */
  position: number | null;
  textColor: string; // #rrggbb
  /** The word being said right now (its text, or its box in the Box style). */
  highlightColor: string;
  /** Words the user marked to stand out. */
  emphasisColor: string;
  uppercase: boolean;
  /** At most this many words on screen at once. */
  maxWords: number;
}

/** A headline shown at the top of the clip (Opus calls it the hook). */
export interface TitleSettings {
  enabled: boolean;
  text: string;
  duration: 'intro' | 'all';
}

export type LogoCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

/** Your logo on the clip (the image itself is in the brand kit). */
export interface LogoSettings {
  enabled: boolean;
  corner: LogoCorner;
  /** Width, as a share of the frame's width. */
  size: number;
  /** 0.2-1 */
  opacity: number;
}

/** Changes to one word of the transcript. */
export interface WordOverride {
  /** Corrected spelling shown in the captions. */
  text?: string;
  /** Kept in the video but left out of the captions. */
  hidden?: boolean;
  /** Shown in the emphasis colour. */
  emphasis?: boolean;
}

/**
 * Manual framing from time `t` on (source seconds): a fixed crop centered at
 * `cx` (0..1 across the source width), or null to follow the speaker again.
 * Applies until the next key.
 */
export interface ReframeKey {
  t: number;
  cx: number | null;
}

/** Everything the user changed about one clip. All times are source seconds. */
export interface ClipEdit {
  v: 1;
  start: number;
  end: number;
  /** Word ids cut out of the video. */
  deleted: string[];
  removeFillers: boolean;
  removePauses: boolean;
  words: Record<string, WordOverride>;
  captions: CaptionSettings;
  title: TitleSettings;
  aspect: AspectRatio;
  layout: LayoutMode;
  /** Split screen: put the person on the right on top. */
  splitSwap: boolean;
  reframe: ReframeKey[];
  logo: LogoSettings;
}

/** "Min stil": how your clips look, saved from the editor and used for new clips. */
export interface BrandStyle {
  captions: CaptionSettings;
  title: Pick<TitleSettings, 'enabled' | 'duration'>;
  logo: LogoSettings;
  savedAt: string;
}

/** The logo image in the brand kit. `version` changes when it's replaced. */
export interface LogoImage {
  width: number;
  height: number;
  version: string;
}

/** Your brand kit, as the editor, upload form and settings page see it. */
export interface BrandInfo {
  fonts: CustomFont[];
  logo: LogoImage | null;
  style: BrandStyle | null;
}

/** One transcript word as the editor sees it. */
export interface EditorWord {
  /** `${segment}:${index in segment}` - stable whichever way the word was timed. */
  id: string;
  text: string;
  start: number; // source seconds
  end: number;
  seg: number;
  /** Timed by Whisper (true) or estimated from Gemini's sentence times. */
  exact: boolean;
  /** A filler sound: eh, öh, um, hmm ... */
  filler: boolean;
}

export interface CropKeyframe {
  t: number; // seconds
  cx: number; // normalized 0..1 horizontal crop center
  /** true: jump to cx at t. false: pan smoothly from the previous keyframe. */
  cut: boolean;
}

/** One person's crop in a split screen: pans with them, fixed zoom. */
export interface SplitHalf {
  keyframes: CropKeyframe[];
  /** Top of the crop, as a share of the frame height. */
  y: number;
  /** Crop height, as a share of the frame height. */
  h: number;
}

/** The face analysis of a stretch of the source (scripts/smart_crop.py). */
export interface FramingAnalysis {
  start: number; // source seconds analysed
  end: number;
  /** What looks best without any input: follow the speaker, or split screen. */
  auto: 'single' | 'split';
  /** Crop keyframes that follow whoever is talking. t = source seconds. */
  keyframes: CropKeyframe[];
  /** The two main people, if there are two. t = source seconds. */
  split: { top: SplitHalf; bottom: SplitHalf } | null;
}

export interface SourceInfo {
  width: number; // as displayed (rotation applied)
  height: number;
  duration: number;
  hasAudio: boolean;
}

/** What the editor needs to know about a clip, besides the user's edits. */
export interface ClipEditorData {
  v: 1;
  /** The stretch of the source the editor works in (the clip plus some context). */
  window: { start: number; end: number };
  words: EditorWord[];
  source: SourceInfo;
  analysis: FramingAnalysis | null;
}

export interface TimeRange {
  start: number;
  end: number;
}
