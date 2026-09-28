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
}

// All fonts are free (SIL OFL or Apache 2.0, see assets/fonts/licenses) and
// cover the Nordic letters.
export const CAPTION_FONTS: CaptionFont[] = [
  { id: 'montserrat', label: 'Montserrat', family: 'Montserrat ExtraBold', file: 'Montserrat-ExtraBold.ttf', emPerSize: 1000 / 1562, ascent: 1109 / 1562, sizeFactor: 1 },
  { id: 'anton', label: 'Anton', family: 'Anton', file: 'Anton-Regular.ttf', emPerSize: 2048 / 3550, ascent: 2876 / 3550, sizeFactor: 1.1 },
  { id: 'bebas', label: 'Bebas Neue', family: 'Bebas Neue', file: 'BebasNeue-Regular.ttf', emPerSize: 1000 / 1300, ascent: 950 / 1300, sizeFactor: 1.1 },
  { id: 'poppins', label: 'Poppins', family: 'Poppins Black', file: 'Poppins-Black.ttf', emPerSize: 1000 / 1762, ascent: 1135 / 1762, sizeFactor: 1.05 },
  { id: 'archivo', label: 'Archivo Black', family: 'Archivo Black', file: 'ArchivoBlack-Regular.ttf', emPerSize: 1000 / 1347, ascent: 1035 / 1347, sizeFactor: 0.9 },
  { id: 'luckiest', label: 'Luckiest Guy', family: 'Luckiest Guy', file: 'LuckiestGuy-Regular.ttf', emPerSize: 2048 / 2510, ascent: 2006 / 2510, sizeFactor: 0.85 },
  { id: 'bangers', label: 'Bangers', family: 'Bangers', file: 'Bangers-Regular.ttf', emPerSize: 1000 / 1757, ascent: 1401 / 1757, sizeFactor: 1.1 },
  { id: 'titan', label: 'Titan One', family: 'Titan One', file: 'TitanOne-Regular.ttf', emPerSize: 1000 / 1145, ascent: 970 / 1145, sizeFactor: 0.8 },
  { id: 'marker', label: 'Permanent Marker', family: 'Permanent Marker', file: 'PermanentMarker-Regular.ttf', emPerSize: 1024 / 1461, ascent: 1136 / 1461, sizeFactor: 0.95 },
];

export function captionFont(id: string): CaptionFont {
  return CAPTION_FONTS.find((f) => f.id === id) ?? CAPTION_FONTS[0];
}

/** CSS family name the preview registers the font under. */
export function cssFontFamily(font: CaptionFont): string {
  return `ac-${font.id}`;
}
