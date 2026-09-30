import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEditorWords, editWindow, keywordWordIds } from './editorWords';
import type { TranscriptSegment } from './types';

const transcript: TranscriptSegment[] = [
  { start: 0, end: 2, text: 'förra meningen här' },
  { start: 2, end: 5, text: 'eh det här är klippet' },
  { start: 5, end: 7, text: 'nästa mening' },
];

test('without Whisper: every word estimated, ids by sentence and position, fillers flagged', () => {
  const words = buildEditorWords(transcript, { start: 0, end: 7 }, { start: 2, end: 5, words: [], exact: false });
  assert.deepEqual(words.map((w) => w.id).slice(0, 5), ['0:0', '0:1', '0:2', '1:0', '1:1']);
  assert.ok(words.every((w) => !w.exact));
  assert.deepEqual(words.filter((w) => w.filler).map((w) => w.text), ['eh']);
});

test("Whisper's times replace the clip's words; neighbours are squeezed off them", () => {
  // Whisper heard the clip's sentence a bit earlier and later than Gemini said.
  const exact = [
    { text: 'eh', start: 1.7, end: 1.9, seg: 1 },
    { text: 'det', start: 2.0, end: 2.2, seg: 1 },
    { text: 'här', start: 2.3, end: 2.5, seg: 1 },
    { text: 'är', start: 2.6, end: 2.7, seg: 1 },
    { text: 'klippet', start: 2.8, end: 5.4, seg: 1 },
  ];
  const words = buildEditorWords(transcript, { start: 0, end: 7 }, { start: 1.6, end: 5.7, words: exact, exact: true });
  const byId = new Map(words.map((w) => [w.id, w]));
  assert.equal(byId.get('1:0')?.start, 1.7);
  assert.equal(byId.get('1:0')?.exact, true);
  // The sentence before now ends before "eh" starts, the one after starts after "klippet".
  assert.ok((byId.get('0:2')?.end ?? 99) <= 1.65 + 1e-9);
  assert.ok((byId.get('2:0')?.start ?? 0) >= 5.45 - 1e-9);
  assert.equal(byId.get('2:0')?.exact, false);
});

test('the editor window reaches 30 s around the clip, inside the video', () => {
  assert.deepEqual(editWindow({ start: 10, end: 40 }, 60), { start: 0, end: 60 });
  assert.deepEqual(editWindow({ start: 100, end: 130 }, 600), { start: 70, end: 160 });
});

test('key words and phrases are found wherever they appear, tiny words never', () => {
  const words = 'det handlar inte om tur utan om konsekvent arbete varje dag och tur igen det är så det blir alltid'
    .split(' ')
    .map((text, i) => ({ id: `0:${i}`, text: i === 4 ? 'Tur,' : text }));
  const ids = keywordWordIds(words, ['tur', 'konsekvent arbete', 'om']);
  // "tur" twice (case and punctuation don't matter), the phrase as two words, never "om".
  assert.deepEqual(ids, ['0:4', '0:12', '0:7', '0:8']);
});

test('at most about a fifth of the words stand out', () => {
  const words = Array.from({ length: 10 }, (_, i) => ({ id: `0:${i}`, text: 'viktigt' }));
  assert.equal(keywordWordIds(words, ['viktigt']).length, 2);
});
