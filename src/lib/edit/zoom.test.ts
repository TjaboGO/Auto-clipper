import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cutTimes, flashWindows, punchSpans, zoomAmount, zoomAmountExpr, zoomBox, zoomedAt, zoomPlan, zoomSegments } from './zoom';
import type { OutputWord } from './timeline';

const w = (text: string, start: number, end: number, seg: number, emphasis = false): OutputWord => ({ id: `${seg}:${text}`, text, start, end, seg, emphasis });

test('every second sentence is closer, and a key word in between gets a short punch-in', () => {
  const words = [
    w('ett', 0, 0.5, 0), w('två', 0.5, 1, 0),
    w('tre', 1.5, 2, 1), w('fyra', 2, 2.5, 1),
    w('fem', 3.5, 4, 2), w('PENGAR', 4, 4.5, 2, true), w('sex', 5.5, 6, 2),
  ];
  const segments = zoomSegments(words, 10);
  assert.deepEqual(segments.map((s) => [Number(s.start.toFixed(2)), Number(s.end.toFixed(2))]), [
    [1.45, 2.6],
    [3.95, 5.1],
  ]);
  assert.equal(zoomedAt(segments, 2), true);
  assert.equal(zoomedAt(segments, 3), false);
});

test('a long sentence is zoomed for at most four seconds, close zooms are joined', () => {
  const long = Array.from({ length: 12 }, (_, i) => w(`ord${i}`, 1 + i * 0.6, 1.5 + i * 0.6, 1));
  const segments = zoomSegments([w('hej', 0, 0.5, 0), ...long], 20);
  assert.equal(segments.length, 1);
  assert.ok(segments[0].end - segments[0].start <= 4.06);
});

test('zooming in keeps the point a bit above the middle in place', () => {
  const box = zoomBox({ x: 100, y: 0, w: 600, h: 1000 }, 1.25);
  assert.deepEqual(box, { x: 160, y: 80, w: 480, h: 800 });
});

const kept = [
  { start: 10, end: 12 },
  { start: 13, end: 14.5 },
  { start: 15, end: 18 },
];

test('cuts, every second part and the flashes are on the finished clip timeline', () => {
  assert.deepEqual(cutTimes(kept), [2, 3.5]);
  assert.deepEqual(punchSpans(kept), [{ start: 2, end: 3.5, ramp: 0 }]);
  assert.deepEqual(flashWindows(kept), [
    { start: 1.97, end: 2.09 },
    { start: 3.47, end: 3.59 },
  ]);
  assert.deepEqual(cutTimes([{ start: 0, end: 5 }]), []);
});

test('a smooth zoom glides in and out, a jump does not', () => {
  const words = [w('ett', 0, 0.5, 0), w('två', 1, 1.5, 1), w('tre', 1.5, 3, 1), w('fyra', 4, 4.5, 2)];
  const smooth = zoomPlan({ zoom: 'medium', zoomStyle: 'smooth', transition: 'none' }, words, [{ start: 0, end: 6 }], 6);
  assert.ok(smooth);
  assert.equal(smooth.factor, 1.18);
  assert.deepEqual(smooth.spans, [{ start: 0.95, end: 3.1, ramp: 0.25 }]);
  assert.equal(zoomAmount(smooth, 0.9), 0);
  assert.ok(zoomAmount(smooth, 1.05) > 0 && zoomAmount(smooth, 1.05) < 0.5);
  assert.equal(zoomAmount(smooth, 2), 1);
  assert.ok(zoomAmount(smooth, 3.0) < 0.5);
  const jump = zoomPlan({ zoom: 'medium', zoomStyle: 'cut', transition: 'none' }, words, [{ start: 0, end: 6 }], 6);
  assert.equal(zoomAmount(jump, 0.96), 1);
  // Nothing to zoom: no plan.
  assert.equal(zoomPlan({ zoom: 'off', zoomStyle: 'smooth', transition: 'flash' }, words, kept, 6), null);
});

test('"Zooma varannan" zooms every second part, with or without the automatic zoom', () => {
  const alone = zoomPlan({ zoom: 'off', zoomStyle: 'smooth', transition: 'punch' }, [], kept, 6.5);
  assert.deepEqual(alone, { factor: 1.12, spans: [{ start: 2, end: 3.5, ramp: 0 }] });
  assert.equal(zoomAmount(alone, 1.99), 0);
  assert.equal(zoomAmount(alone, 2), 1);
  assert.equal(zoomAmount(alone, 3.5), 0);
  const both = zoomPlan({ zoom: 'strong', zoomStyle: 'smooth', transition: 'punch' }, [w('a', 0, 1, 0), w('b', 4, 5, 1)], kept, 6.5);
  assert.equal(both?.factor, 1.28);
  assert.equal(both?.spans.length, 2);
});

test('the render expression matches the preview', () => {
  const plan = { factor: 1.2, spans: [{ start: 1, end: 3, ramp: 0.25 }, { start: 4, end: 5, ramp: 0 }] };
  const expr = zoomAmountExpr(plan, 'T');
  assert.equal(
    expr,
    'min(1,clip((T-1)/0.25,0,1)*clip((3-T)/0.25,0,1)+between(T,4,5))*min(1,clip((T-1)/0.25,0,1)*clip((3-T)/0.25,0,1)+between(T,4,5))*(3-2*min(1,clip((T-1)/0.25,0,1)*clip((3-T)/0.25,0,1)+between(T,4,5)))',
  );
  // Evaluate it the way ffmpeg would, and compare with the preview.
  const evalAt = (T: number) =>
    Function('T', 'clip', 'between', 'min', `return ${expr};`)(
      T,
      (v: number, a: number, b: number) => Math.min(b, Math.max(a, v)),
      (v: number, a: number, b: number) => (v >= a && v <= b ? 1 : 0),
      Math.min,
    ) as number;
  for (const t of [0.5, 1.1, 1.2, 2, 2.9, 3.5, 4.5]) assert.ok(Math.abs(evalAt(t) - zoomAmount(plan, t)) < 1e-9, `t=${t}`);
});
