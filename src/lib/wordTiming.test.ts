import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  alignWords,
  clipSegments,
  estimateWordTimings,
  readLoudness,
  snapClipToWords,
  type HeardWord,
  type Loudness,
} from './wordTiming';
import type { TimedWord } from './types';

/** Caption words for a sentence, with deliberately wrong (estimated) times. */
function captionWords(sentence: string, seg = 0): TimedWord[] {
  return sentence.split(' ').map((text, i) => ({ text, start: 100 + i, end: 101 + i, seg }));
}

/** Heard words back to back from `start`, each `length` long with `gap` between. */
function heardWords(sentence: string, start = 10, length = 0.3, gap = 0.1): HeardWord[] {
  return sentence.split(' ').map((text, i) => ({
    text,
    start: start + i * (length + gap),
    end: start + i * (length + gap) + length,
  }));
}

function starts(words: { start: number }[]): number[] {
  return words.map((w) => Math.round(w.start * 100) / 100);
}

test('same words: every word gets the time Whisper heard it at', () => {
  const heard = heardWords('de flesta tror att det handlar om tur');
  const aligned = alignWords(captionWords('de flesta tror att det handlar om tur'), heard);
  assert.ok(aligned);
  assert.deepEqual(starts(aligned), starts(heard));
  assert.deepEqual(aligned.map((w) => w.text), 'de flesta tror att det handlar om tur'.split(' '));
});

test('words heard before and after the clip (context audio) are ignored', () => {
  const heard = heardWords('slutet av förra meningen de flesta tror att det handlar om tur och sen');
  const aligned = alignWords(captionWords('de flesta tror att det handlar om tur'), heard);
  assert.ok(aligned);
  assert.deepEqual(starts(aligned), starts(heard.slice(4, 12)));
});

test('punctuation and case do not matter', () => {
  const heard = heardWords('okej så här är grejen');
  const aligned = alignWords(captionWords('Okej, så här är grejen.'), heard);
  assert.ok(aligned);
  assert.deepEqual(starts(aligned), starts(heard));
});

test('a word Whisper missed gets the time between its neighbours', () => {
  const heard = heardWords('men egentligen är det bara konsekvent arbete').filter((w) => w.text !== 'det');
  const aligned = alignWords(captionWords('men egentligen är det bara konsekvent arbete'), heard);
  assert.ok(aligned);
  const [ar, det, bara] = aligned.slice(2, 5);
  assert.ok(det.start >= ar.end - 1e-9, 'starts after the word before');
  assert.ok(det.end <= bara.start + 1e-9, 'ends before the word after');
  assert.ok(det.end - det.start > 0.05, 'gets a visible amount of time');
});

test('a missed first word of a sentence goes after the pause, not before it', () => {
  // "slut" ends sentence 0 at 10.3, a 1.2s pause, then "och" (missed) and "sen".
  const words = [
    { text: 'det', start: 0, end: 1, seg: 0 },
    { text: 'var', start: 0, end: 1, seg: 0 },
    { text: 'slut', start: 0, end: 1, seg: 0 },
    { text: 'och', start: 0, end: 1, seg: 1 },
    { text: 'sen', start: 0, end: 1, seg: 1 },
    { text: 'fortsatte', start: 0, end: 1, seg: 1 },
    { text: 'vi', start: 0, end: 1, seg: 1 },
  ];
  const heard: HeardWord[] = [
    ...heardWords('det var slut', 9.1),
    ...heardWords('sen fortsatte vi', 11.8),
  ];
  const aligned = alignWords(words, heard);
  assert.ok(aligned);
  assert.ok(aligned[3].start > 11.2, `"och" at ${aligned[3].start}`);
  assert.ok(aligned[3].end <= 11.8 + 1e-9);
});

test('a missed last word of a sentence goes right after the word before', () => {
  const words = [
    { text: 'vi', start: 0, end: 1, seg: 0 },
    { text: 'gav', start: 0, end: 1, seg: 0 },
    { text: 'aldrig', start: 0, end: 1, seg: 0 },
    { text: 'upp', start: 0, end: 1, seg: 0 },
    { text: 'nästa', start: 0, end: 1, seg: 1 },
    { text: 'grej', start: 0, end: 1, seg: 1 },
  ];
  const heard: HeardWord[] = [...heardWords('vi gav aldrig', 5), ...heardWords('nästa grej', 8)];
  const aligned = alignWords(words, heard);
  assert.ok(aligned);
  assert.ok(Math.abs(aligned[3].start - heard[2].end) < 1e-9, `"upp" at ${aligned[3].start}`);
});

test('mid-sentence, a missed word goes where the audio is loud', () => {
  // "om" is missed; the gap 6.1-7.9 is silent except for a burst at 7.3-7.6.
  const words = captionWords('det handlar om tur');
  const heard: HeardWord[] = [
    { text: 'det', start: 5.4, end: 5.7 },
    { text: 'handlar', start: 5.75, end: 6.1 },
    { text: 'tur', start: 7.9, end: 8.2 },
  ];
  const values = new Float32Array(1000);
  for (let f = 730; f < 760; f++) values[f] = 1;
  const loudness: Loudness = { offset: 0, rate: 100, values };
  const aligned = alignWords(words, heard, loudness);
  assert.ok(aligned);
  assert.ok(aligned[2].start > 7.2 && aligned[2].start < 7.45, `"om" at ${aligned[2].start}`);
});

test('a misheard word next to a missed one pairs with the word it sounds like', () => {
  // Whisper misses "byggde" and hears "ett" as "etx"; there's a pause on
  // both sides of "ett".
  const words = captionWords('vi byggde ett eget');
  const heard: HeardWord[] = [
    { text: 'vi', start: 21.95, end: 22.15 },
    { text: 'etx', start: 23.03, end: 23.34 },
    { text: 'eget', start: 24.19, end: 24.6 },
  ];
  const values = new Float32Array(3000);
  for (let f = 2218; f < 2256; f++) values[f] = 1; // "byggde"
  for (let f = 2306; f < 2329; f++) values[f] = 1; // "ett"
  const aligned = alignWords(words, heard, { offset: 0, rate: 100, values });
  assert.ok(aligned);
  assert.equal(aligned[2].start, 23.03);
  assert.ok(Math.abs(aligned[1].start - 22.18) < 0.06, `"byggde" at ${aligned[1].start}`);
});

test('when the first word was missed, the clip start is never tightened past it', () => {
  // Gemini's estimate puts the segment at 10.0; Whisper missed "okej" and
  // first hears "så" at 11.4.
  const words = [
    { text: 'okej', start: 10.0, end: 10.4, seg: 0 },
    { text: 'så', start: 10.4, end: 10.6, seg: 0 },
    { text: 'här', start: 10.6, end: 10.9, seg: 0 },
    { text: 'är', start: 10.9, end: 11.1, seg: 0 },
    { text: 'det', start: 11.1, end: 11.4, seg: 0 },
  ];
  const heard = heardWords('så här är det', 11.4);
  const aligned = alignWords(words, heard);
  assert.ok(aligned);
  assert.equal(aligned[0].heard, false);
  assert.ok(aligned[0].start <= 10.0 + 1e-9, 'leans on the earlier estimate');
  const edges = snapClipToWords({ start: 10.0, end: 13 }, aligned, heard, 60);
  assert.ok(edges.start <= 10.0 + 1e-9, `clip starts at ${edges.start}`);
});

test('reads loudness from a 16-bit wav file', () => {
  const rate = 16000;
  const samples = new Int16Array(rate); // 1 s: silent, loud in the middle
  for (let k = 8000; k < 9600; k++) samples[k] = 10000;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + samples.byteLength, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(samples.byteLength, 40);
  const file = path.join(os.tmpdir(), `loudness-${process.pid}.wav`);
  fs.writeFileSync(file, Buffer.concat([header, Buffer.from(samples.buffer)]));
  try {
    const loudness = readLoudness(file, 12);
    assert.ok(loudness);
    assert.equal(loudness.values.length, 100);
    assert.equal(loudness.offset, 12);
    assert.equal(loudness.values[10], 0);
    assert.equal(Math.round(loudness.values[55]), 10000);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('misheard and extra filler words still line up', () => {
  // "konsekvens" is close to "konsekvent", "tull" is just wrong, "eh" is extra.
  const heard = heardWords('men eh egentligen är det bara konsekvens arbete om tull varje dag');
  const aligned = alignWords(
    captionWords('men egentligen är det bara konsekvent arbete om tur varje dag'),
    heard,
  );
  assert.ok(aligned);
  const byText = new Map(aligned.map((w) => [w.text, w.start]));
  const heardAt = new Map(heard.map((w) => [w.text, w.start]));
  assert.equal(byText.get('egentligen'), heardAt.get('egentligen'));
  assert.equal(byText.get('konsekvent'), heardAt.get('konsekvens'));
  assert.equal(byText.get('tur'), heardAt.get('tull')); // pinned by its neighbours
});

test('a misheard last word is not glued to the next sentence', () => {
  // Whisper hears "tull" for "tur", then after a pause the next sentence
  // (context audio after the clip) starts with "sen".
  const heard: HeardWord[] = [
    ...heardWords('det handlar om'),
    { text: 'sen', start: 12.5, end: 12.8 },
  ];
  const aligned = alignWords(captionWords('det handlar om tur'), heard);
  assert.ok(aligned);
  const tur = aligned[3];
  assert.ok(tur.start >= heard[2].end - 1e-9, 'placed after "om"');
  assert.ok(tur.start < 12, 'not at the next sentence');
});

test('a compound word split in two by Whisper spans both parts', () => {
  const heard = heardWords('vårt projektlednings verktyg fungerade inte');
  const aligned = alignWords(captionWords('vårt projektledningsverktyg fungerade inte'), heard);
  assert.ok(aligned);
  assert.equal(aligned[1].start, heard[1].start);
  assert.equal(aligned[1].end, heard[2].end);
  assert.equal(aligned[2].start, heard[3].start);
});

test('two words heard as one share its time', () => {
  const heard = heardWords('ses imorgon hejdå allihop');
  const aligned = alignWords(captionWords('ses imorgon hej då allihop'), heard);
  assert.ok(aligned);
  assert.equal(aligned[2].start, heard[2].start);
  assert.equal(aligned[3].end, heard[2].end);
  assert.ok(aligned[2].end > aligned[2].start && aligned[2].end < aligned[3].end);
  assert.equal(aligned[4].start, heard[3].start);
});

test('gives up when the words do not match (wrong language, music)', () => {
  const heard = heardWords('the quick brown fox jumps over the lazy dog today');
  assert.equal(alignWords(captionWords('de flesta tror att det handlar om tur'), heard), null);
  assert.equal(alignWords(captionWords('de flesta tror'), []), null);
});

test('output is always in order and never overlapping', () => {
  const heard: HeardWord[] = [
    { text: 'och', start: 5.0, end: 5.3 },
    { text: 'det', start: 5.25, end: 5.5 }, // overlaps the word before
    { text: 'blev', start: 5.5, end: 5.5001 },
    { text: 'bättre', start: 5.6, end: 6.0 },
  ];
  const aligned = alignWords(captionWords('och det blev bättre'), heard);
  assert.ok(aligned);
  for (let i = 0; i < aligned.length; i++) {
    assert.ok(aligned[i].end > aligned[i].start);
    if (i > 0) assert.ok(aligned[i].start >= aligned[i - 1].end - 1e-9);
  }
});

test('estimated timing splits a segment by word length and covers it exactly', () => {
  const words = estimateWordTimings(
    [
      { start: 0, end: 2, text: 'före klippet' },
      { start: 10, end: 13, text: 'kort jättelångt ord' },
      { start: 30, end: 32, text: 'efter klippet' },
    ],
    9,
    20,
  );
  assert.deepEqual(words.map((w) => w.text), ['kort', 'jättelångt', 'ord']);
  assert.equal(words[0].start, 10);
  assert.equal(words[2].end, 13);
  assert.ok(words[1].end - words[1].start > words[0].end - words[0].start);
  assert.equal(words[0].end, words[1].start);
});

test('a clip owns the segments that mostly fall inside it', () => {
  const transcript = [
    { start: 0, end: 4, text: 'a' }, // 1s of 4 inside -> no
    { start: 4, end: 8, text: 'b' },
    { start: 8, end: 12, text: 'c' },
    { start: 12, end: 16, text: 'd' }, // 3s of 4 inside -> yes
    { start: 16, end: 20, text: 'e' }, // outside
  ];
  assert.deepEqual([...clipSegments(transcript, { start: 3, end: 15 })], [1, 2, 3]);
});

test('clip edges move to real word boundaries', () => {
  const words = [
    { text: 'okej', start: 11.0, end: 11.3, seg: 0 },
    { text: 'slut', start: 19.6, end: 20.0, seg: 0 },
  ];
  // Leading silence and a word right after the end.
  const heard: HeardWord[] = [
    { text: 'förut', start: 9.0, end: 9.5 },
    ...words,
    { text: 'nästa', start: 20.2, end: 20.5 },
  ];
  const edges = snapClipToWords({ start: 10, end: 21 }, words, heard, 60);
  assert.equal(Math.round(edges.start * 100) / 100, 10.88); // 0.12s before the first word
  assert.equal(Math.round(edges.end * 100) / 100, 20.17); // stops before "nästa"
});

test('a clip that cut into its first word is extended, not cut shorter', () => {
  const words = [
    { text: 'okej', start: 9.6, end: 9.9, seg: 0 },
    { text: 'slut', start: 19.6, end: 20.0, seg: 0 },
  ];
  const heard: HeardWord[] = [{ text: 'förut', start: 9.0, end: 9.58 }, ...words];
  const edges = snapClipToWords({ start: 10, end: 20 }, words, heard, 60);
  // The word before ends right at 9.58, so start there instead of 0.12s early.
  assert.equal(Math.round(edges.start * 100) / 100, 9.58);
  assert.equal(Math.round(edges.end * 100) / 100, 20.35);
});

test('edges at something on screen are only widened', () => {
  const words = [
    { text: 'okej', start: 11.0, end: 11.3, seg: 0 },
    { text: 'slut', start: 19.6, end: 20.0, seg: 0 },
  ];
  // The clip starts in the build-up to a goal and ends in its payoff: keep both.
  const held = snapClipToWords({ start: 10, end: 21 }, words, words, 60, { start: true, end: true });
  assert.deepEqual(held, { start: 10, end: 21 });
  // Only the start is held; the end still tightens to the last word.
  const start = snapClipToWords({ start: 10, end: 21 }, words, words, 60, { start: true, end: false });
  assert.deepEqual([start.start, Math.round(start.end * 100) / 100], [10, 20.35]);
});

test('clip edges stay put if they would jump suspiciously far', () => {
  const words = [
    { text: 'okej', start: 16.0, end: 16.3, seg: 0 },
    { text: 'slut', start: 19.6, end: 20.0, seg: 0 },
  ];
  assert.deepEqual(snapClipToWords({ start: 10, end: 20 }, words, words, 60), { start: 10, end: 20 });
});
