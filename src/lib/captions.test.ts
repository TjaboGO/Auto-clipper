import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClipAss } from './captions';
import type { TimedWord } from './types';

function dialogue(ass: string): { start: string; end: string; text: string }[] {
  return ass
    .split('\n')
    .filter((line) => line.startsWith('Dialogue:'))
    .map((line) => {
      const parts = line.split(',');
      return { start: parts[1], end: parts[2], text: parts.slice(9).join(',') };
    });
}

const plain = (text: string) => text.replace(/\{[^}]*\}/g, '');

test('one event per word, with only that word highlighted', () => {
  const words: TimedWord[] = [
    { text: 'hej', start: 10.0, end: 10.4, seg: 0 },
    { text: 'på', start: 10.4, end: 10.6, seg: 0 },
    { text: 'dig', start: 10.6, end: 11.0, seg: 0 },
  ];
  const events = dialogue(buildClipAss(words, 10, 20));
  assert.equal(events.length, 3);
  events.forEach((event, i) => {
    assert.equal(plain(event.text), 'hej på dig');
    assert.equal((event.text.match(/\\c&H/g) ?? []).length, 1);
    assert.ok(event.text.includes(`{\\c&H00D7FF&}${words[i].text}{\\r}`));
  });
  assert.equal(events[0].start, '0:00:00.00'); // shifted to the clip's own timeline
});

test('short gaps between words do not make the caption blink', () => {
  const words: TimedWord[] = [
    { text: 'ett', start: 1.0, end: 1.3, seg: 0 },
    { text: 'två', start: 1.5, end: 1.8, seg: 0 }, // 0.2s gap before
  ];
  const [first] = dialogue(buildClipAss(words, 0, 10));
  assert.equal(first.end, '0:00:01.50'); // held until the next word starts
});

test('a real pause clears the caption shortly after the last word', () => {
  const words: TimedWord[] = [
    { text: 'paus', start: 1.0, end: 1.3, seg: 0 },
    { text: 'här', start: 3.0, end: 3.3, seg: 1 }, // 1.7s later
  ];
  const [first, second] = dialogue(buildClipAss(words, 0, 10));
  assert.equal(first.end, '0:00:01.60');
  assert.equal(second.end, '0:00:03.60');
});

test('a caption page never mixes two sentences', () => {
  const words: TimedWord[] = [
    { text: 'slut', start: 1.0, end: 1.3, seg: 0 },
    { text: 'ny', start: 1.4, end: 1.6, seg: 1 },
    { text: 'mening', start: 1.6, end: 2.0, seg: 1 },
  ];
  const texts = dialogue(buildClipAss(words, 0, 10)).map((e) => plain(e.text));
  assert.deepEqual(texts, ['slut', 'ny mening', 'ny mening']);
});

test('words outside the clip are left out', () => {
  const words: TimedWord[] = [
    { text: 'före', start: 4.0, end: 4.5, seg: 0 },
    { text: 'inne', start: 5.2, end: 5.6, seg: 0 },
    { text: 'efter', start: 9.1, end: 9.5, seg: 0 },
  ];
  const texts = dialogue(buildClipAss(words, 5, 9)).map((e) => plain(e.text));
  assert.deepEqual(texts, ['inne']);
});
