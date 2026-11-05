import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFacecam, parseGroup } from './smartCrop';

const kf = [{ t: 0, cx: 0.5, cut: true }];

test('a webcam box from the analysis is checked and moved to source time', () => {
  const raw = { cam: { x: 0.75, y: 0, w: 0.25, h: 0.3 }, found: 'border', kind: 'game', face: kf, faceY: 0.12, content: kf };
  const fc = parseFacecam(raw, 30);
  assert.ok(fc);
  assert.equal(fc.face[0].t, 30);
  assert.equal(fc.content[0].t, 30);
  assert.equal(fc.found, 'border');
  // Anything strange is turned into the cautious choice, or dropped.
  assert.equal(parseFacecam({ ...raw, found: 'sure', kind: 'movie' }, 0)?.found, 'guess');
  assert.equal(parseFacecam({ ...raw, found: 'sure', kind: 'movie' }, 0)?.kind, 'screen');
  assert.equal(parseFacecam({ ...raw, cam: { x: 0.9, y: 0, w: 0.5, h: 0.3 } }, 0), null);
  assert.equal(parseFacecam({ ...raw, cam: { x: 0, y: 0, w: 0.01, h: 0.3 } }, 0), null);
  assert.equal(parseFacecam({ ...raw, face: [] }, 0), null);
  assert.equal(parseFacecam(null, 0), null);
});

test('a group is 3-4 people with keyframes and face sizes', () => {
  const person = { keyframes: kf, faceY: 0.4, faceH: 0.1 };
  assert.equal(parseGroup([person, person, person], 10)?.[0].keyframes[0].t, 10);
  assert.equal(parseGroup([person, person], 0), null);
  assert.equal(parseGroup([person, person, person, person, person], 0), null);
  assert.equal(parseGroup([person, person, { ...person, faceH: 0 }], 0), null);
});
