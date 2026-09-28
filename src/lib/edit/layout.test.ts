import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitRect, resolveLayout, singleCrop, splitCrop } from './layout';
import type { FramingAnalysis } from './types';

const wide = { width: 1920, height: 1080, duration: 60, hasAudio: true };
const tall = { width: 1080, height: 1920, duration: 60, hasAudio: true };
const half = { keyframes: [{ t: 0, cx: 0.3, cut: true }], y: 0.1, h: 0.5 };
const analysis = (auto: 'single' | 'split', split = true): FramingAnalysis => ({
  start: 0,
  end: 10,
  auto,
  keyframes: [{ t: 0, cx: 0.5, cut: true }],
  split: split ? { top: half, bottom: half } : null,
});

test('auto: follow the speaker, split screen when picked, a narrow source shown whole', () => {
  assert.deepEqual(resolveLayout('auto', '9:16', wide, analysis('single')), { layout: 'single' });
  assert.deepEqual(resolveLayout('auto', '9:16', wide, analysis('split')), { layout: 'split' });
  assert.deepEqual(resolveLayout('auto', '9:16', tall, null), { layout: 'fit' });
  assert.deepEqual(resolveLayout('auto', '16:9', wide, analysis('split')), { layout: 'fit' });
});

test('asking for split screen without two people, or in 16:9, says why not', () => {
  assert.equal(resolveLayout('split', '9:16', wide, analysis('single')).layout, 'split');
  const none = resolveLayout('split', '9:16', wide, analysis('single', false));
  assert.equal(none.layout, 'single');
  assert.match(none.note ?? '', /två personer/);
  assert.match(resolveLayout('split', '16:9', wide, analysis('split')).note ?? '', /16:9/);
});

test('crop boxes: sideways for a wide source, a fixed band for a narrow one', () => {
  assert.deepEqual(singleCrop(wide, { w: 1080, h: 1920 }), { w: 606, h: 1080, y: 0, pans: true });
  assert.deepEqual(singleCrop(tall, { w: 1080, h: 1080 }), { w: 1080, h: 1080, y: 294, pans: false });
  assert.deepEqual(splitCrop(wide, { w: 1080, h: 1920 }, { y: 0.1, h: 0.5 }), { w: 606, h: 540, y: 108, pans: true });
});

test('fit centers the whole frame', () => {
  assert.deepEqual(fitRect(wide, { w: 1080, h: 1920 }), { x: 0, y: 657, w: 1080, h: 606 });
});
