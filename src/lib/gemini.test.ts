import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSuggestions, tidyMoments, type HighlightOptions } from './gemini';
import type { ClipSuggestion, TranscriptSegment, VisualMoment } from './types';

// Ten 10-second segments: 100 s of transcript starting at 20 s.
const transcript: TranscriptSegment[] = Array.from({ length: 10 }, (_, i) => ({
  start: 20 + i * 10,
  end: 20 + i * 10 + 9.5,
  text: `mening ${i}`,
}));

const pick = (start: number, end: number, score = 50, extra: Partial<ClipSuggestion> = {}): ClipSuggestion => ({
  start,
  end,
  title: 'T',
  caption: 'C',
  hashtags: [],
  viralityScore: score,
  reason: 'R',
  ...extra,
});

const options: HighlightOptions = { clipCount: 5, sourceDurationSec: 300, minSeconds: 30, maxSeconds: 60 };

test('picks stay inside the transcript and snap to its boundaries', () => {
  const [clip] = cleanSuggestions([pick(10, 61.2)], transcript, options);
  assert.equal(clip.start, 20); // before the transcript starts: moved in
  assert.equal(clip.end, 59.5); // snapped to the nearest segment end
});

test('too short for the chosen length is dropped, a little short is kept', () => {
  const kept = cleanSuggestions([pick(20, 39.5), pick(50, 59.5)], transcript, options);
  assert.deepEqual(kept.map((c) => c.start), [20]); // 19.5 s kept (>= 60 % of 30), 9.5 s dropped
});

test('runaway clips are capped at the longest length', () => {
  const [clip] = cleanSuggestions([pick(20, 119.5)], transcript, options);
  assert.equal(clip.end, 80);
});

test('existing clips and better picks win overlaps', () => {
  const kept = cleanSuggestions(
    [pick(20, 59.5, 90), pick(40, 79.5, 80), pick(70, 109.5, 70)],
    transcript,
    { ...options, exclude: [{ start: 60, end: 75 }] },
  );
  assert.deepEqual(kept.map((c) => [c.start, c.end]), [[20, 59.5]]);
});

test('key words are cleaned up', () => {
  const [clip] = cleanSuggestions(
    [pick(20, 59.5, 50, { keywords: ['  konsekvent   arbete ', '', 7 as unknown as string, 'x'.repeat(80)] })],
    transcript,
    options,
  );
  assert.deepEqual(clip.keywords, ['konsekvent arbete']);
});

const moment = (start: number, end: number, extra: Partial<VisualMoment> = {}): VisualMoment => ({
  start,
  end,
  kind: 'action',
  intensity: 80,
  description: 'Bollen i mål',
  ...extra,
});

test('what Gemini saw is clamped, sorted and cleaned up', () => {
  const tidy = tidyMoments(
    [
      moment(30, 40),
      moment(5, 12, { kind: 'bogus' as VisualMoment['kind'], intensity: 400, description: '  Ett   mål ' }),
      moment(10, 15), // overlaps the one before: starts where it ends
      moment(20, 20.3), // too short
      moment(25, 28, { description: '' }),
      moment(55, 90), // past the end
    ],
    60,
  );
  assert.deepEqual(
    tidy.map((m) => [m.start, m.end, m.kind, m.intensity, m.description]),
    [
      [5, 12, 'other', 100, 'Ett mål'],
      [12, 15, 'action', 80, 'Bollen i mål'],
      [30, 40, 'action', 80, 'Bollen i mål'],
      [55, 60, 'action', 80, 'Bollen i mål'],
    ],
  );
});

test('with nobody talking, clips can go anywhere in the watched part', () => {
  const opts = { ...options, minSeconds: 15, maxSeconds: 30, visual: [moment(40, 44)], range: { start: 0, end: 120 } };
  const [clip] = cleanSuggestions([pick(38, 55)], [], opts);
  assert.deepEqual([clip.start, clip.end], [38, 55]);
  // Nothing outside the watched part.
  const [late] = cleanSuggestions([pick(100, 130)], [], opts);
  assert.equal(late.end, 120);
});

test('the build-up and payoff of an on-screen moment are kept', () => {
  const opts = { ...options, minSeconds: 15, maxSeconds: 30, visual: [moment(40, 44), moment(60, 70)] };
  // Starts 2 s before the moment: not snapped forward to it (or to the segment start at 40).
  const [clip] = cleanSuggestions([pick(38, 58)], transcript, opts);
  assert.equal(clip.start, 38);
  // A start just inside a moment moves out to include all of it.
  const [inside] = cleanSuggestions([pick(61.5, 80)], transcript, opts);
  assert.equal(inside.start, 60);
  // An end right after a moment isn't pulled back into it.
  const [payoff] = cleanSuggestions([pick(50, 71.5)], transcript, opts);
  assert.equal(payoff.end, 71.5);
});

test('edges in plain talk still snap both ways', () => {
  const opts = { ...options, visual: [moment(100, 104)] };
  const [clip] = cleanSuggestions([pick(41.5, 78)], transcript, opts);
  assert.deepEqual([clip.start, clip.end], [40, 79.5]);
});
