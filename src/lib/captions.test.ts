import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClipAss, type ClipAssOptions } from './captions';
import { presetCaptions } from './edit/presets';
import type { OutputWord } from './edit/timeline';
import type { CaptionPresetId } from './edit/types';

function dialogue(ass: string): { layer: string; start: string; end: string; style: string; text: string }[] {
  return ass
    .split('\n')
    .filter((line) => line.startsWith('Dialogue:'))
    .map((line) => {
      const parts = line.split(',');
      return {
        layer: parts[0].replace('Dialogue: ', ''),
        start: parts[1],
        end: parts[2],
        style: parts[3],
        text: parts.slice(9).join(','),
      };
    });
}

const plain = (text: string) => text.replace(/\{[^}]*\}/g, '');

function word(text: string, start: number, end: number, seg = 0, emphasis = false): OutputWord {
  return { id: `${seg}:${text}`, text, start, end, seg, emphasis };
}

function build(words: OutputWord[], patch: Partial<ClipAssOptions> = {}, preset: CaptionPresetId = 'karaoke'): string {
  return buildClipAss({
    words,
    clipLength: 10,
    captions: presetCaptions(preset),
    title: { enabled: false, text: '', duration: 'intro' },
    out: { w: 1080, h: 1920 },
    layout: 'single',
    aspect: '9:16',
    ...patch,
  });
}

test('one event per word, with only that word highlighted', () => {
  const words = [word('hej', 0, 0.4), word('på', 0.4, 0.6), word('dig', 0.6, 1.0)];
  const events = dialogue(build(words));
  assert.equal(events.length, 3);
  events.forEach((event, i) => {
    assert.equal(plain(event.text), 'hej på dig');
    assert.equal((event.text.match(/\\c&H00D7FF&/g) ?? []).length, 1);
    assert.ok(event.text.includes(`{\\c&H00D7FF&}${words[i].text}`));
  });
  assert.equal(events[0].start, '0:00:00.00');
  // Centered on the lower third of the frame.
  assert.ok(events[0].text.startsWith('{\\an5\\pos(540,1382.4)}'));
});

test('short gaps between words do not make the caption blink', () => {
  const [first] = dialogue(build([word('ett', 1.0, 1.3), word('två', 1.5, 1.8)]));
  assert.equal(first.end, '0:00:01.50'); // held until the next word starts
});

test('a real pause clears the caption shortly after the last word', () => {
  const [first, second] = dialogue(build([word('paus', 1.0, 1.3, 0), word('här', 3.0, 3.3, 1)]));
  assert.equal(first.end, '0:00:01.60');
  assert.equal(second.end, '0:00:03.60');
});

test('a caption page never mixes two sentences', () => {
  const words = [word('slut', 1.0, 1.3, 0), word('ny', 1.4, 1.6, 1), word('mening', 1.6, 2.0, 1)];
  assert.deepEqual(
    dialogue(build(words)).map((e) => plain(e.text)),
    ['slut', 'ny mening', 'ny mening'],
  );
});

test('box style draws a box behind the word being said, under the text', () => {
  const events = dialogue(build([word('en', 0, 0.3), word('ruta', 0.3, 0.8)], {}, 'box'));
  assert.equal(events.length, 4); // box layer + text layer per word
  const [box, text] = events;
  assert.equal(box.style, 'Box');
  assert.equal(box.layer, '0');
  assert.ok(box.text.includes('\\1a&HFF&\\3a&HFF&\\4a&HFF&}{\\3a&H00&}en{\\3a&HFF&} ruta'));
  assert.equal(text.style, 'Caption');
  assert.equal(plain(text.text), 'en ruta');
  assert.ok(!text.text.includes('\\c&H')); // the text itself stays white
});

test('clean style shows each page once, without a highlight', () => {
  const events = dialogue(build([word('lugn', 0, 0.4), word('text', 0.4, 0.9)], {}, 'clean'));
  assert.equal(events.length, 1);
  assert.equal(plain(events[0].text), 'lugn text');
  assert.equal(events[0].end, '0:00:01.20');
});

test('word by word: one big word at a time that pops in, in capitals', () => {
  const events = dialogue(build([word('ett', 0, 0.3), word('ord', 0.3, 0.6)], {}, 'word'));
  assert.deepEqual(events.map((e) => plain(e.text)), ['ETT', 'ORD']);
  assert.ok(events[0].text.includes('\\fscx80\\fscy80\\t(0,100,\\fscx100\\fscy100)'));
});

test('pop style: the word being said grows', () => {
  const [first] = dialogue(build([word('stor', 0, 0.3), word('grej', 0.3, 0.6)], {}, 'pop'));
  assert.ok(first.text.includes('\\fscx115\\fscy115}STOR{\\fscx100\\fscy100}'));
});

test('emphasized words keep their colour while another word is said', () => {
  const [first] = dialogue(build([word('vanligt', 0, 0.3), word('viktigt', 0.3, 0.6, 0, true)]));
  assert.ok(first.text.includes('{\\c&H80DE4A&}viktigt'));
});

test('custom position, other formats and the title', () => {
  const captions = { ...presetCaptions('karaoke'), position: 0.5 };
  const ass = build([word('mitt', 0, 0.5)], {
    captions,
    out: { w: 1080, h: 1080 },
    aspect: '1:1',
    title: { enabled: true, text: 'En rubrik', duration: 'intro' },
  });
  assert.match(ass, /PlayResX: 1080\nPlayResY: 1080/);
  const events = dialogue(ass);
  assert.ok(events[0].text.startsWith('{\\an5\\pos(540,540)}'));
  const title = events.find((e) => e.style === 'Title');
  assert.ok(title);
  assert.equal(title.start, '0:00:00.00');
  assert.equal(title.end, '0:00:03.00');
  assert.equal(plain(title.text), 'En rubrik');
});

test('captions can be turned off', () => {
  const captions = { ...presetCaptions('karaoke'), enabled: false };
  assert.equal(dialogue(build([word('tyst', 0, 0.5)], { captions })).length, 0);
});

test('split screen puts the captions on the seam', () => {
  const [first] = dialogue(build([word('mitten', 0, 0.5)], { layout: 'split' }));
  assert.ok(first.text.startsWith('{\\an5\\pos(540,960)}'));
});

test('a single word too long for the frame is shrunk to fit', () => {
  const [event] = dialogue(build([word('utvecklingsavdelningens', 0, 0.8)], {}, 'word'));
  const scale = Number(/\\t\(0,100,\\fscx(\d+)/.exec(event.text)?.[1]);
  assert.ok(scale > 20 && scale < 100, `scaled to ${scale}%`);
});
