import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultEdit, presetCaptions, sanitizeEdit } from './presets';

const fallback = defaultEdit({ start: 40, end: 70, title: 'Rubrik' });
const ctx = { window: { start: 10, end: 100 }, wordIds: new Set(['0:0', '0:1', '1:0']), fallback };

test('a valid edit comes through as it is', () => {
  const edit = {
    ...fallback,
    start: 35,
    deleted: ['0:1'],
    words: { '1:0': { text: 'rättat', emphasis: true } },
    captions: presetCaptions('box'),
    aspect: '1:1',
    layout: 'split',
    reframe: [{ t: 50, cx: 0.4 }],
  };
  assert.deepEqual(sanitizeEdit(edit, ctx), edit);
});

test('bad values fall back and everything stays inside the window', () => {
  const edit = sanitizeEdit(
    {
      start: 2,
      end: 500,
      deleted: ['0:0', 'nope', 42, '0:0'],
      words: { '0:1': { text: 'x'.repeat(200), hidden: 'yes' }, 'nope': { text: 'a' } },
      captions: { preset: 'fancy', font: 'comic', size: 9, position: 0.99, textColor: 'red', maxWords: 0.2 },
      title: { enabled: true, text: 'Ny\nrubrik', duration: 'forever' },
      aspect: '3:2',
      reframe: [{ t: 200, cx: 3 }, { t: 20, cx: null }, { t: 'x' }],
    },
    ctx,
  );
  assert.equal(edit.start, 10);
  assert.equal(edit.end, 100);
  assert.deepEqual(edit.deleted, ['0:0']);
  assert.deepEqual(edit.words, { '0:1': { text: 'x'.repeat(60) } });
  assert.equal(edit.captions.preset, 'karaoke');
  assert.equal(edit.captions.font, 'montserrat');
  assert.equal(edit.captions.size, 2);
  assert.equal(edit.captions.position, 0.95);
  assert.equal(edit.captions.textColor, '#FFFFFF');
  assert.equal(edit.captions.maxWords, 1);
  assert.deepEqual(edit.title, { enabled: true, text: 'Ny rubrik', duration: 'intro' });
  assert.equal(edit.aspect, '9:16');
  assert.deepEqual(edit.reframe, [{ t: 20, cx: null }, { t: 100, cx: 1 }]);
});

test('a clip too short to render keeps its old edges', () => {
  const edit = sanitizeEdit({ ...fallback, start: 50, end: 50.5 }, ctx);
  assert.equal(edit.start, 40);
  assert.equal(edit.end, 70);
});
