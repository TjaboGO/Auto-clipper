import type { FontId } from './types';

export interface CaptionFont {
  id: FontId;
  label: string;
  /** Family name as libass matches it (from the font file's name table). */
  family: string;
  /** File in assets/fonts (served to the browser by /api/fonts). */
  file: string;
  /**
   * The font's em size per unit of ASS font size. libass sizes a font so its
   * whole line (Windows ascent + descent) equals the font size; a browser
   * sizes the em. The preview multiplies by this to match the render.
   */
  emPerSize: number;
  /** Where the baseline sits in that line, from the top (Windows ascent / line). */
  ascent: number;
  /** How big it looks next to Montserrat at the same size setting. */
  sizeFactor: number;
  /**
   * How wide its letters are next to Montserrat's at the same font size
   * (before sizeFactor): a line holds fewer letters of a wide font (see
   * captionMetrics).
   */
  widthFactor: number;
}

/** A font you uploaded (see brand.ts). */
export interface CustomFont extends CaptionFont {
  /** The file name it was uploaded with. */
  original: string;
  /** Has å, ä and ö (without them, those letters come from another font). */
  nordic: boolean;
  addedAt: string;
}

// All fonts are free (SIL OFL or Apache 2.0, see assets/fonts/licenses) and
// cover the Nordic letters.
export const CAPTION_FONTS: CaptionFont[] = [
  { id: 'montserrat', label: 'Montserrat', family: 'Montserrat ExtraBold', file: 'Montserrat-ExtraBold.ttf', emPerSize: 1000 / 1562, ascent: 1109 / 1562, sizeFactor: 1, widthFactor: 1 },
  { id: 'anton', label: 'Anton', family: 'Anton', file: 'Anton-Regular.ttf', emPerSize: 2048 / 3550, ascent: 2876 / 3550, sizeFactor: 1.1, widthFactor: 0.67 },
  { id: 'bebas', label: 'Bebas Neue', family: 'Bebas Neue', file: 'BebasNeue-Regular.ttf', emPerSize: 1000 / 1300, ascent: 950 / 1300, sizeFactor: 1.1, widthFactor: 0.76 },
  { id: 'poppins', label: 'Poppins', family: 'Poppins Black', file: 'Poppins-Black.ttf', emPerSize: 1000 / 1762, ascent: 1135 / 1762, sizeFactor: 1.05, widthFactor: 0.89 },
  { id: 'archivo', label: 'Archivo Black', family: 'Archivo Black', file: 'ArchivoBlack-Regular.ttf', emPerSize: 1000 / 1347, ascent: 1035 / 1347, sizeFactor: 0.9, widthFactor: 1.16 },
  { id: 'luckiest', label: 'Luckiest Guy', family: 'Luckiest Guy', file: 'LuckiestGuy-Regular.ttf', emPerSize: 2048 / 2510, ascent: 2006 / 2510, sizeFactor: 0.85, widthFactor: 1.23 },
  { id: 'bangers', label: 'Bangers', family: 'Bangers', file: 'Bangers-Regular.ttf', emPerSize: 1000 / 1757, ascent: 1401 / 1757, sizeFactor: 1.1, widthFactor: 0.61 },
  { id: 'titan', label: 'Titan One', family: 'Titan One', file: 'TitanOne-Regular.ttf', emPerSize: 1000 / 1145, ascent: 970 / 1145, sizeFactor: 0.8, widthFactor: 1.4 },
  { id: 'marker', label: 'Permanent Marker', family: 'Permanent Marker', file: 'PermanentMarker-Regular.ttf', emPerSize: 1024 / 1461, ascent: 1136 / 1461, sizeFactor: 0.95, widthFactor: 0.99 },
  { id: 'inter', label: 'Inter', family: 'Inter Black', file: 'Inter-Black.ttf', emPerSize: 2048 / 2929, ascent: 2269 / 2929, sizeFactor: 1.0, widthFactor: 1.04 },
  { id: 'rubik', label: 'Rubik', family: 'Rubik Black', file: 'Rubik-Black.ttf', emPerSize: 1000 / 1532, ascent: 1066 / 1532, sizeFactor: 0.99, widthFactor: 1.01 },
  { id: 'oswald', label: 'Oswald', family: 'Oswald Bold', file: 'Oswald-Bold.ttf', emPerSize: 1000 / 1702, ascent: 1325 / 1702, sizeFactor: 1.08, widthFactor: 0.68 },
  { id: 'barlow', label: 'Barlow Condensed', family: 'Barlow Condensed ExtraBold', file: 'BarlowCondensed-ExtraBold.ttf', emPerSize: 1000 / 1349, ascent: 1075 / 1349, sizeFactor: 1.02, widthFactor: 0.8 },
  { id: 'nunito', label: 'Nunito', family: 'Nunito Black', file: 'Nunito-Black.ttf', emPerSize: 1000 / 1377, ascent: 1077 / 1377, sizeFactor: 0.94, widthFactor: 1.01 },
  { id: 'fredoka', label: 'Fredoka', family: 'Fredoka Bold', file: 'Fredoka-Bold.ttf', emPerSize: 1000 / 1251, ascent: 999 / 1251, sizeFactor: 0.89, widthFactor: 1.05 },
  { id: 'lilita', label: 'Lilita One', family: 'Lilita One', file: 'LilitaOne-Regular.ttf', emPerSize: 1000 / 1143, ascent: 923 / 1143, sizeFactor: 0.85, widthFactor: 1.09 },
  { id: 'kanit', label: 'Kanit', family: 'Kanit ExtraBold', file: 'Kanit-ExtraBold.ttf', emPerSize: 1000 / 1580, ascent: 1180 / 1580, sizeFactor: 1.08, widthFactor: 0.9 },
  { id: 'caveat', label: 'Caveat', family: 'Caveat Bold', file: 'Caveat-Bold.ttf', emPerSize: 1000 / 1289, ascent: 974 / 1289, sizeFactor: 1.12, widthFactor: 0.72 },
  { id: 'pacifico', label: 'Pacifico', family: 'Pacifico Regular', file: 'Pacifico-Regular.ttf', emPerSize: 1000 / 1935, ascent: 1478 / 1935, sizeFactor: 1.25, widthFactor: 0.6 },
  { id: 'pixel', label: 'Press Start 2P', family: 'Press Start 2P Regular', file: 'PressStart2P-Regular.ttf', emPerSize: 1000 / 1374, ascent: 1000 / 1374, sizeFactor: 0.68, widthFactor: 1.85 },
];

// Fonts you uploaded (see brand.ts). They're known on the server once the
// brand kit is loaded, and in the browser once the editor or settings page
// gets them from the API. Kept on globalThis so every copy of this module
// sees the same list.
const registry = globalThis as { __autoClipperCustomFonts?: CaptionFont[] };

export function setCustomFonts(fonts: CaptionFont[]): void {
  registry.__autoClipperCustomFonts = fonts;
}

export function customFonts(): CaptionFont[] {
  return registry.__autoClipperCustomFonts ?? [];
}

export function isCustomFontId(id: string): boolean {
  return id.startsWith('u-');
}

/** Every caption font: the ones that come with the app, then yours. */
export function allFonts(): CaptionFont[] {
  return [...CAPTION_FONTS, ...customFonts()];
}

/** A font by id; a font that's gone (deleted, unknown) falls back to Montserrat. */
export function captionFont(id: string): CaptionFont {
  return CAPTION_FONTS.find((f) => f.id === id) ?? customFonts().find((f) => f.id === id) ?? CAPTION_FONTS[0];
}

/** CSS family name the preview registers the font under. */
export function cssFontFamily(font: CaptionFont): string {
  return `ac-${font.id}`;
}
