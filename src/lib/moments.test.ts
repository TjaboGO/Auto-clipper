import { test } from 'node:test';
import assert from 'node:assert/strict';
import { screenEdges, speechShare } from './moments';
import type { VisualMoment } from './types';

const moment = (start: number, end: number): VisualMoment => ({
  start,
  end,
  kind: 'action',
  intensity: 80,
  description: 'Ett mål',
});

test('speech share is the part of the range with talk', () => {
  const transcript = [
    { start: 0, end: 10, text: 'a' },
    { start: 50, end: 70, text: 'b' }, // half of it is outside the range
  ];
  assert.equal(speechShare(transcript, { start: 0, end: 60 }), 20 / 60);
  assert.equal(speechShare([], { start: 0, end: 60 }), 0);
  assert.equal(speechShare(transcript, { start: 20, end: 40 }), 0);
});

test('edges in the build-up to, or inside, an on-screen moment are held', () => {
  const moments = [moment(10, 14)];
  assert.deepEqual(screenEdges({ start: 7, end: 16 }, moments), { start: true, end: true }); // build-up, payoff
  assert.deepEqual(screenEdges({ start: 12, end: 13 }, moments), { start: true, end: true }); // inside
  assert.deepEqual(screenEdges({ start: 2, end: 30 }, moments), { start: false, end: false }); // far away
  assert.deepEqual(screenEdges({ start: 15, end: 40 }, moments), { start: false, end: false }); // after it
  assert.deepEqual(screenEdges({ start: 7, end: 16 }, []), { start: false, end: false });
});
