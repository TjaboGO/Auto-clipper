import type {
  AspectRatio,
  CropKeyframe,
  FacecamInfo,
  FramingAnalysis,
  GroupPerson,
  LayoutMode,
  LogoSettings,
  SourceInfo,
  SplitHalf,
} from './types';

export interface OutputSize {
  w: number;
  h: number;
}

export const OUTPUT_SIZES: Record<AspectRatio, OutputSize> = {
  '9:16': { w: 1080, h: 1920 },
  '1:1': { w: 1080, h: 1080 },
  '4:5': { w: 1080, h: 1350 },
  '16:9': { w: 1920, h: 1080 },
};

export const ASPECT_LABELS: Record<AspectRatio, string> = {
  '9:16': '9:16 Stående',
  '1:1': '1:1 Kvadrat',
  '4:5': '4:5 Porträtt',
  '16:9': '16:9 Liggande',
};

export type ResolvedLayout = 'single' | 'split' | 'fit' | 'facecam' | 'screen' | 'group';

/** Layouts that stack parts of the picture (split screen, facecam, screen) need a frame that isn't wide. */
export function splitAllowed(aspect: AspectRatio): boolean {
  return aspect !== '16:9';
}

/**
 * What the layout setting means for this source and format. `note` says why
 * a wish couldn't be met (e.g. split screen without two people in view).
 */
export function resolveLayout(
  mode: LayoutMode,
  aspect: AspectRatio,
  source: SourceInfo,
  analysis: FramingAnalysis | null,
): { layout: ResolvedLayout; note?: string } {
  const out = OUTPUT_SIZES[aspect];
  if (mode === 'fit') return { layout: 'fit' };
  if (mode === 'fill') return { layout: 'single' };
  if (mode === 'split') {
    if (!splitAllowed(aspect)) return { layout: 'single', note: 'Split screen finns inte i 16:9.' };
    if (!analysis?.split) return { layout: 'single', note: 'Split screen kräver två personer i bild.' };
    return { layout: 'split' };
  }
  if (mode === 'facecam' || mode === 'screen') {
    const name = mode === 'facecam' ? 'Spel med facecam' : 'Skärm med ansikte';
    if (!splitAllowed(aspect)) return { layout: 'single', note: `${name} finns inte i 16:9.` };
    if (!analysis?.facecam) return { layout: 'single', note: `${name} kräver en person som syns hela tiden, till exempel i en webbkamera.` };
    return { layout: mode };
  }
  if (mode === 'group') {
    if (!analysis?.group) return { layout: 'single', note: 'Grupp kräver 3-4 personer i bild.' };
    return { layout: 'group' };
  }
  // auto: a source that's already as narrow as the format is shown whole.
  if (source.width / source.height <= out.w / out.h + 0.01) return { layout: 'fit' };
  const auto = analysis?.auto;
  if ((auto === 'facecam' || auto === 'screen') && analysis?.facecam && splitAllowed(aspect)) return { layout: auto };
  if (auto === 'group' && analysis?.group) return { layout: 'group' };
  if (auto === 'split' && analysis?.split && splitAllowed(aspect)) return { layout: 'split' };
  return { layout: 'single' };
}

function even(n: number): number {
  return Math.max(2, Math.floor(n / 2) * 2);
}

/** A crop box in source pixels. `x` is where it sits when it doesn't move sideways. */
export interface CropBox {
  w: number;
  h: number;
  y: number;
  /** true when the crop follows a horizontal position (the source is wider than the format). */
  pans: boolean;
}

/**
 * The crop that fills the whole output with one part of the source. A wider
 * source pans sideways; a narrower one gets a fixed band a bit above the
 * middle (where faces usually are).
 */
export function singleCrop(source: SourceInfo, out: OutputSize): CropBox {
  const { width, height } = source;
  if (width / height > out.w / out.h) {
    return { w: Math.min(even(width), even((height * out.w) / out.h)), h: even(height), y: 0, pans: true };
  }
  const h = Math.min(even(height), even((width * out.h) / out.w));
  return { w: even(width), h, y: Math.round((height - h) * 0.35), pans: false };
}

/**
 * Left edge of a panning crop centered on `cx` (0..1), kept inside the
 * frame, or inside min..max (e.g. a webcam box).
 */
export function cropLeft(cx: number, cropWidth: number, sourceWidth: number, min = 0, max = sourceWidth - cropWidth): number {
  return Math.max(min, Math.min(max, Math.round(cx * sourceWidth - cropWidth / 2)));
}

// ---------------------------------------------------------------------------
// Layouts made of parts: split screen, facecam, screen and group
// ---------------------------------------------------------------------------

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * One part of the frame: a crop of the source drawn into a rectangle of the
 * output. The crop has a fixed size and top, and moves sideways with its
 * keyframes, its left edge kept between minX and maxX (source pixels).
 */
export interface Panel {
  /** What's in it: a person, a webcam, the gameplay or the screen. */
  role: 'person' | 'camera' | 'game' | 'screen';
  /** Where it goes, in output pixels. */
  dest: Rect;
  w: number;
  h: number;
  y: number;
  keyframes: CropKeyframe[];
  minX: number;
  maxX: number;
}

export interface PanelOptions {
  layout: ResolvedLayout;
  source: SourceInfo;
  out: OutputSize;
  analysis: FramingAnalysis | null;
  /** Split screen: the person on the right on top. Facecam and screen: the camera / screen at the bottom. */
  swap: boolean;
  /** Facecam: the camera's share of the height. Screen: the screen's. null = automatic. */
  panelSize: number | null;
}

/** The smallest and biggest share of the height the camera or screen can get. */
export const PANEL_SIZE_RANGE = { min: 0.2, max: 0.7 };

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

/**
 * A crop with the shape of `dest`: `height` tall if it fits, else as big as
 * the source (or the box `within`, in source pixels) allows.
 */
function shapedCrop(dest: Rect, height: number, within: { w: number; h: number }): { w: number; h: number } {
  const aspect = dest.w / dest.h;
  let h = Math.min(height, within.h);
  let w = h * aspect;
  if (w > within.w) {
    w = within.w;
    h = w / aspect;
  }
  return { w: even(w), h: even(h) };
}

/** Rows (or columns) that split `size` into `n` even parts, the last one taking what's left. */
function cuts(size: number, n: number): number[] {
  return Array.from({ length: n + 1 }, (_, i) => (i === 0 ? 0 : i === n ? size : even((size * i) / n)));
}

function stacked(out: OutputSize, topHeight: number): [Rect, Rect] {
  const top = clamp(even(topHeight), 2, out.h - 2);
  return [
    { x: 0, y: 0, w: out.w, h: top },
    { x: 0, y: top, w: out.w, h: out.h - top },
  ];
}

/** One person of a split screen: the crop height the analysis picked, the panel's shape. */
function splitPanel(source: SourceInfo, dest: Rect, half: SplitHalf): Panel {
  const { w, h } = shapedCrop(dest, half.h * source.height, { w: source.width, h: source.height });
  const y = clamp(Math.round(half.y * source.height), 0, source.height - h);
  return { role: 'person', dest, w, h, y, keyframes: half.keyframes, minX: 0, maxX: source.width - w };
}

/** The webcam, cut to the panel's shape around the face, never outside the webcam box. */
function cameraPanel(source: SourceInfo, dest: Rect, facecam: FacecamInfo): Panel {
  const box = {
    x: facecam.cam.x * source.width,
    y: facecam.cam.y * source.height,
    w: facecam.cam.w * source.width,
    h: facecam.cam.h * source.height,
  };
  const { w, h } = shapedCrop(dest, box.h, box);
  const y = clamp(Math.round(facecam.faceY * source.height - 0.45 * h), Math.ceil(box.y), Math.floor(box.y + box.h - h));
  const minX = Math.min(source.width - w, Math.ceil(box.x));
  const maxX = Math.max(minX, Math.min(source.width - w, Math.floor(box.x + box.w - w)));
  return { role: 'camera', dest, w, h, y, keyframes: facecam.face, minX, maxX };
}

/**
 * The gameplay or the screen: as much of the frame as fits the panel's
 * shape, following the action. The game's crop stays clear of a webcam at
 * the side of the frame when it fits beside it (no face twice).
 */
function contentPanel(source: SourceInfo, dest: Rect, facecam: FacecamInfo, role: 'game' | 'screen'): Panel {
  const { w, h } = shapedCrop(dest, source.height, { w: source.width, h: source.height });
  const y = Math.round((source.height - h) / 2);
  let minX = 0;
  let maxX = source.width - w;
  if (role === 'game') {
    // A little extra room: the box is found just inside a frame around the webcam.
    const margin = 0.02 * source.width;
    const camLeft = facecam.cam.x * source.width - margin;
    const camRight = (facecam.cam.x + facecam.cam.w) * source.width + margin;
    if (camLeft <= 0.05 * source.width && camRight + w <= source.width) minX = Math.ceil(camRight);
    else if (camRight >= 0.95 * source.width && camLeft - w >= 0) maxX = Math.floor(camLeft - w);
  }
  return { role, dest, w, h, y, keyframes: facecam.content, minX, maxX };
}

/**
 * Facecam: how much of the height the camera gets unless you say: enough
 * to show all of it across the width, within reason.
 */
export function defaultCamShare(source: SourceInfo, out: OutputSize, facecam: FacecamInfo): number {
  const camAspect = (facecam.cam.w * source.width) / (facecam.cam.h * source.height);
  return clamp(out.w / camAspect / out.h, 0.28, 0.45);
}

/** Screen: how much of the height the screen gets unless you say: all of it across the width. */
export function defaultScreenShare(source: SourceInfo, out: OutputSize): number {
  return clamp((out.w * source.height) / source.width / out.h, PANEL_SIZE_RANGE.min, PANEL_SIZE_RANGE.max);
}

/** Where the 3-4 people of a group go: rows, columns, or two up and one or two down. */
export function groupRects(count: number, out: OutputSize): Rect[] {
  const rows = cuts(out.h, 2);
  const cols = cuts(out.w, 2);
  if (count === 3) {
    if (out.h >= 1.5 * out.w) {
      const y = cuts(out.h, 3);
      return [0, 1, 2].map((i) => ({ x: 0, y: y[i], w: out.w, h: y[i + 1] - y[i] }));
    }
    if (out.w >= 1.5 * out.h) {
      const x = cuts(out.w, 3);
      return [0, 1, 2].map((i) => ({ x: x[i], y: 0, w: x[i + 1] - x[i], h: out.h }));
    }
    return [
      { x: 0, y: 0, w: cols[1], h: rows[1] },
      { x: cols[1], y: 0, w: out.w - cols[1], h: rows[1] },
      { x: 0, y: rows[1], w: out.w, h: out.h - rows[1] },
    ];
  }
  return [
    { x: 0, y: 0, w: cols[1], h: rows[1] },
    { x: cols[1], y: 0, w: out.w - cols[1], h: rows[1] },
    { x: 0, y: rows[1], w: cols[1], h: out.h - rows[1] },
    { x: cols[1], y: rows[1], w: out.w - cols[1], h: out.h - rows[1] },
  ];
}

/**
 * One person of a group: the face takes up a fixed share of the panel's
 * height, more in a wide panel (head and shoulders) than in a tall one.
 */
function groupPanel(source: SourceInfo, dest: Rect, person: GroupPerson): Panel {
  const faceShare = clamp(0.2 + 0.1 * (dest.w / dest.h), 0.22, 0.38);
  const height = Math.max((person.faceH * source.height) / faceShare, 0.25 * source.height);
  const { w, h } = shapedCrop(dest, height, { w: source.width, h: source.height });
  const y = clamp(Math.round(person.faceY * source.height - 0.42 * h), 0, source.height - h);
  return { role: 'person', dest, w, h, y, keyframes: person.keyframes, minX: 0, maxX: source.width - w };
}

/**
 * The parts of the frame for split screen, facecam, screen and group, top
 * to bottom (null for the other layouts, or without the analysis they need).
 * Keyframes are the analysis's, in source seconds.
 */
export function framePanels(o: PanelOptions): Panel[] | null {
  const { source, out, analysis } = o;
  if (o.layout === 'split' && analysis?.split) {
    const [first, second] = o.swap ? [analysis.split.bottom, analysis.split.top] : [analysis.split.top, analysis.split.bottom];
    const [top, bottom] = stacked(out, out.h / 2);
    return [splitPanel(source, top, first), splitPanel(source, bottom, second)];
  }
  if ((o.layout === 'facecam' || o.layout === 'screen') && analysis?.facecam) {
    const facecam = analysis.facecam;
    const size = typeof o.panelSize === 'number' ? clamp(o.panelSize, PANEL_SIZE_RANGE.min, PANEL_SIZE_RANGE.max) : null;
    // The camera's (or screen's) part has the same height on top as at the bottom.
    const share = size ?? (o.layout === 'facecam' ? defaultCamShare(source, out, facecam) : defaultScreenShare(source, out));
    const height = clamp(even(out.h * share), 2, out.h - 2);
    const [top, bottom] = stacked(out, o.swap ? out.h - height : height);
    if (o.layout === 'facecam') {
      return o.swap
        ? [contentPanel(source, top, facecam, 'game'), cameraPanel(source, bottom, facecam)]
        : [cameraPanel(source, top, facecam), contentPanel(source, bottom, facecam, 'game')];
    }
    return o.swap
      ? [cameraPanel(source, top, facecam), contentPanel(source, bottom, facecam, 'screen')]
      : [contentPanel(source, top, facecam, 'screen'), cameraPanel(source, bottom, facecam)];
  }
  if (o.layout === 'group' && analysis?.group && analysis.group.length >= 3) {
    const people = analysis.group.slice(0, 4);
    return groupRects(people.length, out).map((dest, i) => groupPanel(source, dest, people[i]));
  }
  return null;
}

/** Where the whole source sits inside the output when it's shown uncropped ("fit"). */
export function fitRect(source: SourceInfo, out: OutputSize): { x: number; y: number; w: number; h: number } {
  const scale = Math.min(out.w / source.width, out.h / source.height);
  const w = even(source.width * scale);
  const h = even(source.height * scale);
  return { x: Math.round((out.w - w) / 2), y: Math.round((out.h - h) / 2), w, h };
}

// Space between the logo and the frame's edges (share of the short side),
// and the most of the frame's height a tall logo may take.
const LOGO_MARGIN = 0.04;
const LOGO_MAX_HEIGHT = 0.25;

/** Where the logo goes in the finished frame, in output pixels. */
export function logoRect(
  out: OutputSize,
  image: { width: number; height: number },
  logo: LogoSettings,
): { x: number; y: number; w: number; h: number } {
  let w = out.w * logo.size;
  let h = (w * image.height) / image.width;
  if (h > out.h * LOGO_MAX_HEIGHT) {
    h = out.h * LOGO_MAX_HEIGHT;
    w = (h * image.width) / image.height;
  }
  w = Math.max(2, Math.round(w));
  h = Math.max(2, Math.round(h));
  const margin = Math.round(Math.min(out.w, out.h) * LOGO_MARGIN);
  return {
    x: logo.corner.endsWith('left') ? margin : out.w - w - margin,
    y: logo.corner.startsWith('top') ? margin : out.h - h - margin,
    w,
    h,
  };
}

/**
 * Caption position when the user hasn't picked one (center, as a share of
 * the height): the lower third; between the two parts of a split screen or
 * a facecam; low in the face's part of a screen layout; on the line between
 * rows of a group closest to the lower third.
 */
export function defaultCaptionPosition(layout: ResolvedLayout, aspect: AspectRatio, panels: Panel[] | null = null): number {
  const lowerThird = aspect === '16:9' ? 0.84 : aspect === '9:16' ? 0.72 : 0.78;
  if (!panels || panels.length < 2) return layout === 'split' ? 0.5 : lowerThird;
  const height = Math.max(...panels.map((p) => p.dest.y + p.dest.h));
  if (layout === 'screen') {
    const camera = panels.find((p) => p.role === 'camera');
    if (camera) return (camera.dest.y + 0.6 * camera.dest.h) / height;
  }
  const seams = [...new Set(panels.map((p) => p.dest.y).filter((y) => y > 0))].map((y) => y / height);
  if (seams.length === 0) return lowerThird;
  return seams.reduce((best, y) => (Math.abs(y - 0.6) < Math.abs(best - 0.6) ? y : best));
}
