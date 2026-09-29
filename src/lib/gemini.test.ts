import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSuggestions, type HighlightOptions } from './gemini';
import type { ClipSuggestion, TranscriptSegment } from './types';

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
