// Reads what the app needs from a TrueType/OpenType font file: its names,
// the metrics libass sizes text with, and whether it has the Nordic letters.
// Plain TypeScript on a Buffer, so uploaded fonts can be checked on the
// server without any font tools installed.

export interface FontFileInfo {
  format: 'ttf' | 'otf';
  /** The family without the weight ("Montserrat"), for showing. */
  family: string;
  /** The family as older software sees it, often with the weight ("Montserrat ExtraBold"). */
  legacyFamily: string;
  subfamily: string;
  /** The full name ("Montserrat ExtraBold"): libass matches it, and it's unique per file. */
  fullName: string;
  postscriptName: string;
  copyright: string;
  unitsPerEm: number;
  /** The line libass sizes text by (usually OS/2 Windows ascent/descent). */
  lineAscent: number;
  lineDescent: number;
  /** Height of capital letters, if the font says (OS/2 v2+). */
  capHeight: number | null;
  weight: number;
  /** Has å, ä, ö, Å, Ä, Ö. */
  nordic: boolean;
  /** Average advance width of a-z, in font units (null if it can't be read). */
  averageWidth: number | null;
}

const NORDIC = [0xe5, 0xe4, 0xf6, 0xc5, 0xc4, 0xd6];

class Reader {
  constructor(private buf: Buffer) {}
  u16(at: number): number {
    this.check(at, 2);
    return this.buf.readUInt16BE(at);
  }
  i16(at: number): number {
    this.check(at, 2);
    return this.buf.readInt16BE(at);
  }
  u32(at: number): number {
    this.check(at, 4);
    return this.buf.readUInt32BE(at);
  }
  tag(at: number): string {
    this.check(at, 4);
    return this.buf.toString('latin1', at, at + 4);
  }
  slice(at: number, length: number): Buffer {
    this.check(at, length);
    return this.buf.subarray(at, at + length);
  }
  private check(at: number, length: number) {
    if (at < 0 || at + length > this.buf.length) throw new Error('Typsnittsfilen är trasig (för kort).');
  }
}

function decodeName(bytes: Buffer, platform: number): string {
  if (platform === 0 || platform === 3) {
    // UTF-16 big endian
    const chars: number[] = [];
    for (let i = 0; i + 1 < bytes.length; i += 2) chars.push(bytes.readUInt16BE(i));
    return String.fromCharCode(...chars);
  }
  return bytes.toString('latin1'); // Mac Roman: close enough for names
}

/** Name table entries by name id, preferring Windows English, then any Windows, then Mac. */
function readNames(r: Reader, offset: number): Map<number, string> {
  const count = r.u16(offset + 2);
  const strings = offset + r.u16(offset + 4);
  const best = new Map<number, { rank: number; text: string }>();
  for (let i = 0; i < count; i++) {
    const rec = offset + 6 + i * 12;
    const platform = r.u16(rec);
    const encoding = r.u16(rec + 2);
    const language = r.u16(rec + 4);
    const id = r.u16(rec + 6);
    const length = r.u16(rec + 8);
    const at = strings + r.u16(rec + 10);
    let rank: number;
    if (platform === 3 && (encoding === 1 || encoding === 10)) rank = language === 0x409 ? 3 : 2;
    else if (platform === 0) rank = 2;
    else if (platform === 1 && encoding === 0) rank = 1;
    else continue;
    const current = best.get(id);
    if (current && current.rank >= rank) continue;
    try {
      best.set(id, { rank, text: decodeName(r.slice(at, length), platform).replace(/\0/g, '').trim() });
    } catch {
      // A broken record: skip it.
    }
  }
  return new Map([...best].map(([id, v]) => [id, v.text]));
}

/** A code point -> glyph id lookup from the Unicode cmap (formats 4 and 12); 0 = missing. */
function glyphLookup(r: Reader, offset: number): (cp: number) => number {
  const count = r.u16(offset + 2);
  let format4: number | null = null;
  let format12: number | null = null;
  for (let i = 0; i < count; i++) {
    const rec = offset + 4 + i * 8;
    const platform = r.u16(rec);
    const encoding = r.u16(rec + 2);
    const sub = offset + r.u32(rec + 4);
    const format = r.u16(sub);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode) continue;
    if (format === 12) format12 = sub;
    if (format === 4) format4 = sub;
  }
  return (cp: number): number => {
    if (format12 !== null) {
      const groups = r.u32(format12 + 12);
      for (let g = 0; g < groups; g++) {
        const at = format12 + 16 + g * 12;
        const first = r.u32(at);
        if (cp >= first && cp <= r.u32(at + 4)) return r.u32(at + 8) + (cp - first);
      }
      return 0;
    }
    if (format4 !== null) {
      const segX2 = r.u16(format4 + 6);
      const ends = format4 + 14;
      const starts = ends + segX2 + 2;
      const deltas = starts + segX2;
      const ranges = deltas + segX2;
      for (let s = 0; s < segX2; s += 2) {
        if (cp > r.u16(ends + s)) continue;
        const start = r.u16(starts + s);
        if (cp < start) return 0;
        const delta = r.i16(deltas + s);
        const rangeOffset = r.u16(ranges + s);
        if (rangeOffset === 0) return (cp + delta) & 0xffff;
        const glyph = r.u16(ranges + s + rangeOffset + (cp - start) * 2);
        return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
      }
    }
    return 0;
  };
}

/** Average advance width of a-z (hmtx), or null if the tables aren't there. */
function averageLetterWidth(r: Reader, glyph: (cp: number) => number, hhea: number, hmtx: number | undefined): number | null {
  if (hmtx === undefined) return null;
  const metrics = r.u16(hhea + 34);
  if (metrics === 0) return null;
  let sum = 0;
  let found = 0;
  for (let cp = 0x61; cp <= 0x7a; cp++) {
    const id = glyph(cp);
    if (id === 0) continue;
    sum += r.u16(hmtx + Math.min(id, metrics - 1) * 4);
    found++;
  }
  return found >= 20 ? sum / found : null;
}

/** Read a .ttf/.otf file. Throws with a message for the user if it isn't one. */
export function readFontFile(buf: Buffer): FontFileInfo {
  const r = new Reader(buf);
  const version = r.u32(0);
  const tagName = r.tag(0);
  if (tagName === 'ttcf') throw new Error('Typsnittssamlingar (.ttc) stöds inte. Välj en enskild .ttf eller .otf.');
  if (tagName === 'wOFF' || tagName === 'wOF2') throw new Error('WOFF-filer stöds inte. Välj en .ttf eller .otf.');
  if (version !== 0x00010000 && tagName !== 'OTTO' && tagName !== 'true') {
    throw new Error('Det här är ingen typsnittsfil (.ttf eller .otf).');
  }
  const numTables = r.u16(4);
  const tables = new Map<string, number>();
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    tables.set(r.tag(rec), r.u32(rec + 8));
  }
  const head = tables.get('head');
  const hhea = tables.get('hhea');
  const name = tables.get('name');
  const cmap = tables.get('cmap');
  if (head === undefined || hhea === undefined || name === undefined || cmap === undefined) {
    throw new Error('Typsnittsfilen saknar delar som behövs (head, hhea, name eller cmap).');
  }
  const os2 = tables.get('OS/2');
  const unitsPerEm = r.u16(head + 18);
  if (unitsPerEm < 16 || unitsPerEm > 16384) throw new Error('Typsnittsfilen har ogiltiga mått.');

  // The same order libass picks the line height in.
  let lineAscent = 0;
  let lineDescent = 0;
  let capHeight: number | null = null;
  let weight = 400;
  if (os2 !== undefined) {
    const os2Version = r.u16(os2);
    weight = r.u16(os2 + 4);
    const winAscent = r.i16(os2 + 74);
    const winDescent = r.i16(os2 + 76);
    if (winAscent + winDescent !== 0) {
      lineAscent = winAscent;
      lineDescent = winDescent;
    }
    if (os2Version >= 2) {
      const cap = r.i16(os2 + 88);
      if (cap > 0) capHeight = cap;
    }
  }
  if (lineAscent + lineDescent <= 0) {
    lineAscent = r.i16(hhea + 4);
    lineDescent = -r.i16(hhea + 6);
  }
  if (lineAscent + lineDescent <= 0) {
    lineAscent = r.i16(head + 42);
    lineDescent = -r.i16(head + 38);
  }
  if (lineAscent + lineDescent <= 0) throw new Error('Typsnittsfilen har ogiltiga mått.');

  const glyph = glyphLookup(r, cmap);
  const names = readNames(r, name);
  const family = names.get(16) || names.get(1) || '';
  if (!family) throw new Error('Typsnittet saknar namn.');
  const subfamily = names.get(17) || names.get(2) || 'Regular';
  return {
    format: tagName === 'OTTO' ? 'otf' : 'ttf',
    family,
    legacyFamily: names.get(1) || family,
    subfamily,
    fullName: names.get(4) || `${family} ${subfamily}`,
    postscriptName: names.get(6) || '',
    copyright: names.get(0) || '',
    unitsPerEm,
    lineAscent,
    lineDescent,
    capHeight,
    weight,
    nordic: NORDIC.every((cp) => glyph(cp) !== 0),
    averageWidth: averageLetterWidth(r, glyph, hhea, tables.get('hmtx')),
  };
}

// Montserrat ExtraBold, the default caption font, per unit of ASS font
// size: the height of its capitals and the average width of a-z. Other
// fonts get a size factor half-way towards the same capital height
// (condensed fonts with tall capitals would look too small otherwise), and
// a width factor so lines hold fewer letters of a wide font.
const REFERENCE_CAP_PER_SIZE = 0.448;
const REFERENCE_WIDTH_PER_SIZE = 0.394;

export interface FontMetrics {
  emPerSize: number;
  ascent: number;
  sizeFactor: number;
  widthFactor: number;
}

/** The numbers the caption layout needs (see CaptionFont in edit/fonts.ts). */
export function captionMetrics(info: FontFileInfo): FontMetrics {
  const line = info.lineAscent + info.lineDescent;
  const emPerSize = info.unitsPerEm / line;
  const capPerSize = info.capHeight ? (info.capHeight / info.unitsPerEm) * emPerSize : null;
  const sizeFactor = capPerSize ? Math.min(1.25, Math.max(0.75, Math.sqrt(REFERENCE_CAP_PER_SIZE / capPerSize))) : 1;
  // Per unit of font size, before the size factor (the layout applies that on its own).
  const widthPerSize = info.averageWidth ? (info.averageWidth / info.unitsPerEm) * emPerSize : null;
  const widthFactor = widthPerSize ? Math.min(2, Math.max(0.6, widthPerSize / REFERENCE_WIDTH_PER_SIZE)) : 1;
  return {
    emPerSize: Math.round(emPerSize * 10000) / 10000,
    ascent: Math.round((info.lineAscent / line) * 10000) / 10000,
    sizeFactor: Math.round(sizeFactor * 100) / 100,
    widthFactor: Math.round(widthFactor * 100) / 100,
  };
}
