import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zoomBox, zoomedAt, zoomSegments } from './zoom';
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
