import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { captionMetrics, readFontFile } from './fontFile';
import { CAPTION_FONTS, captionFont, customFonts, setCustomFonts, type CustomFont } from './edit/fonts';
import { captionMetrics as layoutMetrics } from './edit/captionLayout';
import { presetCaptions } from './edit/presets';

const fontsDir = path.join(process.cwd(), 'assets', 'fonts');
const read = (file: string) => readFontFile(fs.readFileSync(path.join(fontsDir, file)));

test('names and metrics are read from a font file', () => {
  const info = read('Montserrat-ExtraBold.ttf');
  assert.equal(info.format, 'ttf');
  assert.equal(info.family, 'Montserrat');
  assert.equal(info.legacyFamily, 'Montserrat ExtraBold');
  assert.equal(info.fullName, 'Montserrat ExtraBold');
  assert.equal(info.weight, 800);
  assert.equal(info.nordic, true);
  // The same numbers the bundled font list was made with.
  const m = captionMetrics(info);
  const known = captionFont('montserrat');
  assert.equal(m.emPerSize, Math.round(known.emPerSize * 10000) / 10000);
  assert.equal(m.ascent, Math.round(known.ascent * 10000) / 10000);
  assert.equal(m.sizeFactor, 1);
  assert.equal(m.widthFactor, 1);
});

test('every bundled font can be read and has the Nordic letters', () => {
  for (const font of CAPTION_FONTS) {
    const info = read(font.file);
    assert.equal(info.nordic, true, font.file);
    assert.ok(info.averageWidth && info.averageWidth > 0, font.file);
  }
});

test('files that are not fonts are turned away with a reason', () => {
  assert.throws(() => readFontFile(Buffer.from('hello, this is no font at all')), /ingen typsnittsfil/);
  assert.throws(() => readFontFile(Buffer.from('wOFF\0\0\0\0\0\0\0\0')), /WOFF/);
  assert.throws(() => readFontFile(Buffer.from('ttcf\0\0\0\0\0\0\0\0')), /\.ttc/);
  assert.throws(() => readFontFile(Buffer.alloc(3)), /trasig/);
  // A real header with its tables cut off.
  const cut = fs.readFileSync(path.join(fontsDir, 'Anton-Regular.ttf')).subarray(0, 200);
  assert.throws(() => readFontFile(cut), /trasig|saknar/);
});

test('your fonts are found by id, and a deleted one falls back to Montserrat', () => {
  const mine: CustomFont = {
    ...captionFont('inter'),
    id: 'u-abc123',
    label: 'Min font',
    file: 'u-abc123.ttf',
    original: 'min.ttf',
    nordic: true,
    addedAt: '2026-01-01T00:00:00Z',
  };
  setCustomFonts([mine]);
  try {
    assert.equal(captionFont('u-abc123').label, 'Min font');
    assert.equal(customFonts().length, 1);
    setCustomFonts([]);
    assert.equal(captionFont('u-abc123').id, 'montserrat');
  } finally {
    setCustomFonts([]);
  }
});

test('a wide font fits fewer letters on a line', () => {
  const out = { w: 1080, h: 1920 };
  const normal = layoutMetrics(presetCaptions('karaoke'), out, 'single', '9:16');
  const pixel = layoutMetrics({ ...presetCaptions('karaoke'), font: 'pixel' }, out, 'single', '9:16');
  const narrow = layoutMetrics({ ...presetCaptions('karaoke'), font: 'oswald' }, out, 'single', '9:16');
  assert.ok(pixel.maxChars < normal.maxChars, `${pixel.maxChars} < ${normal.maxChars}`);
  assert.ok(narrow.maxChars > normal.maxChars, `${narrow.maxChars} > ${normal.maxChars}`);
});
