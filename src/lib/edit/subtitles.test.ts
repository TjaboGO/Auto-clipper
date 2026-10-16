import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSrt, buildVtt, subtitleCues } from './subtitles';
import { translatedWords } from './translation';
import type { OutputWord } from './timeline';

const w = (text: string, start: number, end: number, seg = 0): OutputWord => ({ id: `${seg}:${text}`, text, start, end, seg, emphasis: false });

test('subtitles: one cue per sentence chunk, SRT and VTT timestamps', () => {
  const words = [w('Hej', 0.5, 0.8), w('allihop', 0.8, 1.4), w('välkomna', 2.0, 2.6, 1), w('hit', 2.6, 3.0, 1)];
  const cues = subtitleCues(words, 10);
  assert.equal(cues.length, 2); // never across two sentences
  assert.deepEqual(cues[0].lines, ['Hej allihop']);
  // Up through the short pause until the next sentence; the last one a moment after its last word.
  assert.equal(
    buildSrt(cues),
    '1\n00:00:00,500 --> 00:00:02,000\nHej allihop\n\n2\n00:00:02,000 --> 00:00:03,300\nvälkomna hit\n',
  );
  assert.match(buildVtt(cues), /^WEBVTT\n\n00:00:00\.500 --> 00:00:02\.000\nHej allihop\n/);
});

test('long sentences become two even lines, and new cues past about 84 characters', () => {
  const text = 'det här är en ganska lång mening som absolut inte får plats på en enda rad i en undertext och fortsätter';
  const words = text.split(' ').map((t, i) => w(t, i * 0.3, i * 0.3 + 0.25));
  const cues = subtitleCues(words, 30);
  assert.ok(cues.length >= 2);
  for (const c of cues) {
    assert.ok(c.lines.length <= 2);
    for (const line of c.lines) assert.ok(line.length <= 46, line);
  }
});

test('a translated sentence is spread over the time the spoken one takes', () => {
  const words = [w('Hej', 1, 1.5), w('allihop', 1.5, 2.5), w('ja', 3, 3.2, 1)];
  const out = translatedWords(words, { lang: 'en', segments: { '0': 'Hello everyone out there' } });
  assert.deepEqual(out.map((x) => x.text), ['Hello', 'everyone', 'out', 'there', 'ja']);
  assert.equal(out[0].start, 1);
  assert.ok(Math.abs(out[3].end - 2.5) < 1e-9);
  // Longer words get more time.
  assert.ok(out[1].end - out[1].start > out[2].end - out[2].start);
  // No translation: unchanged.
  assert.equal(translatedWords(words, null), words);
});

test('the sentences a clip needs translated: in the clip, as the user spells them', async () => {
  const { sentencesToTranslate } = await import('./translation');
  const word = (id: string, text: string, start: number, seg: number) => ({ id, text, start, end: start + 0.4, seg, exact: true, filler: false });
  const words = [word('0:0', 'före', 1, 0), word('1:0', 'Hej', 5, 1), word('1:1', 'eh', 5.5, 1), word('1:2', 'värld', 6, 1), word('2:0', 'sen', 20, 2)];
  const sentences = sentencesToTranslate(words, { start: 4, end: 10, words: { '1:1': { hidden: true }, '1:2': { text: 'världen' } } });
  assert.deepEqual(sentences, [{ id: 1, text: 'Hej världen' }]);
});

test('a translation from the editor is checked: known language, text per sentence', async () => {
  const { sanitizeTranslation } = await import('./presets');
  assert.deepEqual(sanitizeTranslation({ lang: 'en', segments: { '3': ' Hello\nthere ', x: 'bad', '4': 7 } }, null), {
    lang: 'en',
    segments: { '3': 'Hello there' },
  });
  assert.equal(sanitizeTranslation({ lang: 'xx', segments: {} }, null), null);
  assert.equal(sanitizeTranslation(null, { lang: 'en', segments: {} }), null);
  assert.deepEqual(sanitizeTranslation('nope', { lang: 'de', segments: {} }), { lang: 'de', segments: {} });
});
