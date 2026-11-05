import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultCaptionPosition, fitRect, framePanels, groupRects, logoRect, resolveLayout, singleCrop } from './layout';
import type { AutoLayout, FacecamInfo, FramingAnalysis, GroupPerson } from './types';

const wide = { width: 1920, height: 1080, duration: 60, hasAudio: true };
const tall = { width: 1080, height: 1920, duration: 60, hasAudio: true };
const half = { keyframes: [{ t: 0, cx: 0.3, cut: true }], y: 0.1, h: 0.5 };
const analysis = (auto: AutoLayout, split = true, extra: Partial<FramingAnalysis> = {}): FramingAnalysis => ({
  start: 0,
  end: 10,
  auto,
  keyframes: [{ t: 0, cx: 0.5, cut: true }],
  split: split ? { top: half, bottom: half } : null,
  ...extra,
});
const facecam: FacecamInfo = {
  cam: { x: 0.75, y: 0, w: 0.25, h: 0.25 },
  found: 'border',
  kind: 'game',
  face: [{ t: 0, cx: 0.87, cut: true }],
  faceY: 0.1,
  content: [{ t: 0, cx: 0.5, cut: true }],
};
const person = (cx: number): GroupPerson => ({ keyframes: [{ t: 0, cx, cut: true }], faceY: 0.4, faceH: 0.1 });
const group = [person(0.2), person(0.5), person(0.8)];

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
});

test('split screen: two crops of half the frame each, swapped on request', () => {
  const panels = framePanels({ layout: 'split', source: wide, out: { w: 1080, h: 1920 }, analysis: analysis('split'), swap: false, panelSize: null });
  assert.ok(panels);
  assert.deepEqual(
    panels.map((p) => [p.dest, p.w, p.h, p.y]),
    [
      [{ x: 0, y: 0, w: 1080, h: 960 }, 606, 540, 108],
      [{ x: 0, y: 960, w: 1080, h: 960 }, 606, 540, 108],
    ],
  );
  // 4:5 has an odd half (675): the parts get even heights.
  const fourFive = framePanels({ layout: 'split', source: wide, out: { w: 1080, h: 1350 }, analysis: analysis('split'), swap: false, panelSize: null });
  assert.deepEqual(fourFive?.map((p) => p.dest.h), [674, 676]);
});

test('facecam and screen: picked by auto when found, asked for when there is a webcam, never in 16:9', () => {
  const found = analysis('facecam', false, { facecam });
  assert.deepEqual(resolveLayout('auto', '9:16', wide, found), { layout: 'facecam' });
  assert.deepEqual(resolveLayout('auto', '9:16', wide, analysis('screen', false, { facecam })), { layout: 'screen' });
  assert.deepEqual(resolveLayout('auto', '16:9', wide, found), { layout: 'fit' });
  assert.deepEqual(resolveLayout('screen', '9:16', wide, found), { layout: 'screen' });
  assert.match(resolveLayout('facecam', '9:16', wide, analysis('single')).note ?? '', /webbkamera/);
  assert.match(resolveLayout('facecam', '16:9', wide, found).note ?? '', /16:9/);
  // Older analyses don't have the field at all.
  assert.equal(resolveLayout('group', '9:16', wide, analysis('single')).layout, 'single');
});

test('facecam: the camera across the width on top, the game filling the rest; sizes and swap', () => {
  const out = { w: 1080, h: 1920 };
  const opts = { layout: 'facecam' as const, source: wide, out, analysis: analysis('facecam', false, { facecam }), swap: false, panelSize: null };
  const [camera, game] = framePanels(opts) ?? [];
  assert.equal(camera.role, 'camera');
  assert.equal(camera.dest.h, 606); // a 16:9 webcam across 1080 px
  // Inside the webcam box (1440..1920 x 0..270).
  assert.ok(camera.minX >= 1440 && camera.maxX + camera.w <= 1920 && camera.y + camera.h <= 270);
  assert.equal(game.role, 'game');
  assert.equal(game.maxX, Math.floor(1440 - 0.02 * 1920 - game.w)); // the game stays left of the webcam
  const [bigCamera] = framePanels({ ...opts, panelSize: 0.5 }) ?? [];
  assert.equal(bigCamera.dest.h, 960);
  const swapped = framePanels({ ...opts, swap: true }) ?? [];
  assert.deepEqual(swapped.map((p) => p.role), ['game', 'camera']);
  assert.equal(swapped[1].dest.y, 1920 - 606);
});

test('screen: the whole screen across the width on top, the face below', () => {
  const out = { w: 1080, h: 1920 };
  const [screen, camera] =
    framePanels({ layout: 'screen', source: wide, out, analysis: analysis('screen', false, { facecam }), swap: false, panelSize: null }) ?? [];
  assert.equal(screen.role, 'screen');
  assert.deepEqual(screen.dest, { x: 0, y: 0, w: 1080, h: 606 });
  assert.equal(screen.w, 1920); // nothing of the screen cut off at the sides
  assert.deepEqual(camera.dest, { x: 0, y: 606, w: 1080, h: 1314 });
});

test('group: rows in 9:16, two up and one down in 1:1, columns in 16:9, a grid for four', () => {
  assert.deepEqual(groupRects(3, { w: 1080, h: 1920 }).map((r) => [r.y, r.h]), [[0, 640], [640, 640], [1280, 640]]);
  assert.deepEqual(groupRects(3, { w: 1080, h: 1080 }), [
    { x: 0, y: 0, w: 540, h: 540 },
    { x: 540, y: 0, w: 540, h: 540 },
    { x: 0, y: 540, w: 1080, h: 540 },
  ]);
  assert.deepEqual(groupRects(3, { w: 1920, h: 1080 }).map((r) => [r.x, r.w]), [[0, 640], [640, 640], [1280, 640]]);
  assert.deepEqual(groupRects(4, { w: 1080, h: 1920 }).map((r) => [r.x, r.y]), [[0, 0], [540, 0], [0, 960], [540, 960]]);
  const panels = framePanels({ layout: 'group', source: wide, out: { w: 1080, h: 1920 }, analysis: analysis('group', false, { group }), swap: false, panelSize: null });
  assert.equal(panels?.length, 3);
  // Each crop has its panel's shape and the face a good part of it.
  for (const p of panels ?? []) assert.ok(Math.abs(p.w / p.h - 1080 / 640) < 0.02 && p.h < 540, JSON.stringify(p));
});

test('captions go between the parts: the seam of a facecam, low in the face of a screen layout', () => {
  const out = { w: 1080, h: 1920 };
  const base = { source: wide, out, swap: false, panelSize: null };
  const cam = framePanels({ ...base, layout: 'facecam', analysis: analysis('facecam', false, { facecam }) });
  assert.equal(defaultCaptionPosition('facecam', '9:16', cam), 606 / 1920);
  const screen = framePanels({ ...base, layout: 'screen', analysis: analysis('screen', false, { facecam }) });
  assert.equal(defaultCaptionPosition('screen', '9:16', screen), (606 + 0.6 * 1314) / 1920);
  const rows = framePanels({ ...base, layout: 'group', analysis: analysis('group', false, { group }) });
  assert.equal(defaultCaptionPosition('group', '9:16', rows), 1280 / 1920);
  assert.equal(defaultCaptionPosition('single', '9:16'), 0.72);
});

test('fit centers the whole frame', () => {
  assert.deepEqual(fitRect(wide, { w: 1080, h: 1920 }), { x: 0, y: 657, w: 1080, h: 606 });
});

test('the logo sits in its corner, sized by the frame width, a tall one kept in check', () => {
  const out = { w: 1080, h: 1920 };
  const wideLogo = { width: 400, height: 200 };
  const logo = { enabled: true, corner: 'top-right' as const, size: 0.2, opacity: 1 };
  // 20 % of 1080 = 216 wide, margin 4 % of 1080 = 43.
  assert.deepEqual(logoRect(out, wideLogo, logo), { x: 1080 - 216 - 43, y: 43, w: 216, h: 108 });
  assert.deepEqual(logoRect(out, wideLogo, { ...logo, corner: 'bottom-left' }), { x: 43, y: 1920 - 108 - 43, w: 216, h: 108 });
  // A very tall logo is held to a quarter of the height.
  const tallLogo = { width: 100, height: 1000 };
  const rect = logoRect(out, tallLogo, { ...logo, size: 0.4 });
  assert.equal(rect.h, 480);
  assert.equal(rect.w, 48);
});
