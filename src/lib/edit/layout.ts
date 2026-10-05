import type { AspectRatio, FramingAnalysis, LayoutMode, LogoSettings, SourceInfo } from './types';

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

export type ResolvedLayout = 'single' | 'split' | 'fit';

/** Split screen stacks two people, which only works in a frame taller than it is wide-ish. */
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
  // auto: a source that's already as narrow as the format is shown whole.
  if (source.width / source.height <= out.w / out.h + 0.01) return { layout: 'fit' };
  if (analysis?.auto === 'split' && analysis.split && splitAllowed(aspect)) return { layout: 'split' };
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

/** One person's crop in a split screen, filling half the output (top or bottom). */
export function splitCrop(
  source: SourceInfo,
  out: OutputSize,
  half: { y: number; h: number },
): CropBox {
  const { width, height } = source;
  const halfHeight = out.h / 2;
  const h = Math.min(even(height), even(half.h * height));
  const w = Math.min(even(width), even((h * out.w) / halfHeight));
  const y = Math.max(0, Math.min(height - h, Math.round(half.y * height)));
  return { w, h, y, pans: true };
}

/** Left edge of a panning crop centered on `cx` (0..1), kept inside the frame. */
export function cropLeft(cx: number, cropWidth: number, sourceWidth: number): number {
  return Math.max(0, Math.min(sourceWidth - cropWidth, Math.round(cx * sourceWidth - cropWidth / 2)));
}

/** Where the whole source sits inside the output when it's shown uncropped ("fit"). */
export function fitRect(source: SourceInfo, out: OutputSize): { x: number; y: number; w: number; h: number } {
  const scale = Math.min(out.w / source.width, out.h / source.height);
  const w = even(source.width * scale);
  const h = even(source.height * scale);
  return { x: Math.round((out.w - w) / 2), y: Math.round((out.h - h) / 2), w, h };
}

/** Caption position when the user hasn't picked one: lower third, or the seam of a split screen. */
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

export function defaultCaptionPosition(layout: ResolvedLayout, aspect: AspectRatio): number {
  if (layout === 'split') return 0.5;
  return aspect === '16:9' ? 0.84 : aspect === '9:16' ? 0.72 : 0.78;
}
