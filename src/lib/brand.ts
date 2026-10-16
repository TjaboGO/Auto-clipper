// Your brand kit: fonts you uploaded, your logo and "Min stil" (the look new
// clips get). Kept in storage/brand; brand.json lists what's there.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { config } from './config';
import { run } from './exec';
import { captionMetrics, readFontFile } from './fontFile';
import { probeDimensions } from './probe';
import { setCustomFonts, type CustomFont } from './edit/fonts';
import { sanitizeStyle } from './edit/presets';
import type { BrandInfo, BrandStyle, LogoImage } from './edit/types';

export const MAX_FONTS = 30;
export const MAX_FONT_BYTES = 20 * 1024 * 1024;
export const MAX_LOGO_BYTES = 10 * 1024 * 1024;
// The logo is stored no bigger than this; it's a corner of a 1080p frame.
const LOGO_MAX_SIDE = 800;

// Runtime data, not code: the paths are marked so the bundler doesn't trace them.
const brandFile = () => path.join(/* turbopackIgnore: true */ config.brandDir, 'brand.json');
const fontsDir = () => path.join(/* turbopackIgnore: true */ config.brandDir, 'fonts');
export const logoFile = () => path.join(/* turbopackIgnore: true */ config.brandDir, 'logo.png');

let cache: BrandInfo | null = null;

function load(): BrandInfo {
  if (cache) return cache;
  let raw: Partial<BrandInfo> = {};
  try {
    raw = JSON.parse(fs.readFileSync(brandFile(), 'utf8'));
  } catch {
    // No brand kit yet.
  }
  const fonts = Array.isArray(raw.fonts)
    ? raw.fonts.filter(
        (f) =>
          f &&
          typeof f.id === 'string' &&
          /^u-[0-9a-f]+$/.test(f.id) &&
          typeof f.file === 'string' &&
          fs.existsSync(path.join(/* turbopackIgnore: true */ fontsDir(), path.basename(f.file))),
      )
    : [];
  cache = {
    fonts,
    logo: raw.logo && fs.existsSync(logoFile()) ? raw.logo : null,
    style: raw.style ?? null,
  };
  setCustomFonts(cache.fonts);
  return cache;
}

function save(next: BrandInfo): void {
  fs.mkdirSync(config.brandDir, { recursive: true });
  const tmp = `${brandFile()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, brandFile());
  cache = next;
  setCustomFonts(next.fonts);
}

/** The whole brand kit (also makes your fonts known to the caption code). */
export function brandInfo(): BrandInfo {
  return load();
}

/** "Min stil", checked again: a font that has been deleted falls back to the default. */
export function brandStyle(): BrandStyle | null {
  const { style } = load();
  return style ? sanitizeStyle(style) : null;
}

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

/** Add an uploaded .ttf/.otf. Throws with a message for the user if it can't be used. */
export function addFont(buf: Buffer, originalName: string): CustomFont {
  const brand = load();
  if (brand.fonts.length >= MAX_FONTS) {
    throw new Error(`Du kan ha högst ${MAX_FONTS} egna typsnitt. Ta bort något först.`);
  }
  const info = readFontFile(buf);
  const id = `u-${crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10)}` as const;
  if (brand.fonts.some((f) => f.id === id)) throw new Error('Det här typsnittet är redan uppladdat.');
  // libass finds the font by name, and the name goes in a comma-separated
  // style line: the full name, or the older family name, without commas.
  const family = [info.fullName, info.legacyFamily].find((name) => name && !name.includes(','));
  if (!family) throw new Error('Typsnittets namn innehåller kommatecken, och det fungerar inte i texterna.');

  const file = `${id}.${info.format}`;
  fs.mkdirSync(fontsDir(), { recursive: true });
  fs.writeFileSync(path.join(/* turbopackIgnore: true */ fontsDir(), file), buf);
  const regular = /^(regular|normal|book|roman)$/i.test(info.subfamily);
  const font: CustomFont = {
    id,
    label: (regular ? info.family : `${info.family} ${info.subfamily}`).slice(0, 60),
    family,
    file,
    ...captionMetrics(info),
    original: path.basename(originalName).slice(0, 120),
    nordic: info.nordic,
    addedAt: new Date().toISOString(),
  };
  save({ ...brand, fonts: [...brand.fonts, font] });
  return font;
}

export function removeFont(id: string): boolean {
  const brand = load();
  const font = brand.fonts.find((f) => f.id === id);
  if (!font) return false;
  fs.rmSync(path.join(/* turbopackIgnore: true */ fontsDir(), path.basename(font.file)), { force: true });
  // Min stil with this font gets the default one instead.
  const style =
    brand.style?.captions.font === id
      ? { ...brand.style, captions: { ...brand.style.captions, font: 'montserrat' as const } }
      : brand.style;
  save({ ...brand, fonts: brand.fonts.filter((f) => f.id !== id), style });
  return true;
}

/** The file of one of your fonts, by its file name (for serving and rendering), or null. */
export function customFontPath(file: string): string | null {
  const font = load().fonts.find((f) => f.file === file);
  return font ? path.join(/* turbopackIgnore: true */ fontsDir(), path.basename(font.file)) : null;
}

// ---------------------------------------------------------------------------
// Logo
// ---------------------------------------------------------------------------

function isImage(buf: Buffer): boolean {
  const png = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const webp = buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP';
  return png || jpeg || webp;
}

/**
 * Save an uploaded logo (PNG, JPEG or WebP) as a PNG no bigger than
 * LOGO_MAX_SIDE, keeping transparency.
 */
export async function setLogo(buf: Buffer): Promise<LogoImage> {
  if (!isImage(buf)) throw new Error('Loggan måste vara en PNG-, JPEG- eller WebP-bild.');
  fs.mkdirSync(config.brandDir, { recursive: true });
  const upload = path.join(/* turbopackIgnore: true */ config.brandDir, `logo-upload-${process.pid}-${Date.now()}`);
  const converted = path.join(/* turbopackIgnore: true */ config.brandDir, `logo-new-${process.pid}-${Date.now()}.png`);
  fs.writeFileSync(upload, buf);
  try {
    await run(
      'ffmpeg',
      [
        '-v', 'error',
        '-y',
        '-i', upload,
        '-frames:v', '1',
        '-vf', `scale='min(${LOGO_MAX_SIDE},iw)':'min(${LOGO_MAX_SIDE},ih)':force_original_aspect_ratio=decrease`,
        '-pix_fmt', 'rgba',
        converted,
      ],
      {},
      60 * 1000,
    );
    const { width, height } = await probeDimensions(converted);
    fs.renameSync(converted, logoFile());
    const logo: LogoImage = { width, height, version: Date.now().toString(36) };
    save({ ...load(), logo });
    return logo;
  } catch (err) {
    console.warn('[brand] could not read the logo:', err);
    throw new Error('Kunde inte läsa bilden. Prova en annan PNG eller JPEG.');
  } finally {
    fs.rmSync(upload, { force: true });
    fs.rmSync(converted, { force: true });
  }
}

export function removeLogo(): void {
  fs.rmSync(logoFile(), { force: true });
  save({ ...load(), logo: null });
}

// ---------------------------------------------------------------------------
// Min stil
// ---------------------------------------------------------------------------

export function saveStyle(raw: unknown): BrandStyle {
  const style = sanitizeStyle(raw);
  if (!style) throw new Error('Stilen saknar textinställningar.');
  save({ ...load(), style });
  return style;
}

export function clearStyle(): void {
  save({ ...load(), style: null });
}
