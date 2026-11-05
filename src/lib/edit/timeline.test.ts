import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultEdit } from './presets';
import {
  applyReframe,
  clipWords,
  computeCuts,
  cxAt,
  endAfterWord,
  keptRanges,
  keyframesForRange,
  outputDuration,
  outputWords,
  playableTime,
  startBeforeWord,
  toOutputTime,
  toSourceTime,
} from './timeline';
import type { ClipEdit, EditorWord } from './types';

function w(id: string, text: string, start: number, end: number, extra: Partial<EditorWord> = {}): EditorWord {
  return { id, text, start, end, seg: 0, exact: true, filler: false, ...extra };
}

// "vi ska eh prata om det" with a long pause before "om".
const words: EditorWord[] = [
  w('0:0', 'vi', 10.0, 10.3),
  w('0:1', 'ska', 10.4, 10.7),
  w('0:2', 'eh', 10.8, 11.1, { filler: true }),
  w('0:3', 'prata', 11.2, 11.6),
  w('0:4', 'om', 12.8, 13.0),
  w('0:5', 'det', 13.1, 13.4),
];

function edit(patch: Partial<ClipEdit> = {}): ClipEdit {
  return { ...defaultEdit({ start: 9.9, end: 13.8, title: '' }), ...patch };
}

test('a word belongs to the clip when its middle is inside it', () => {
  assert.deepEqual(
    clipWords(words, { start: 10.2, end: 13.0 }).map((x) => x.text),
    ['ska', 'eh', 'prata', 'om'],
  );
});

test('nothing removed: the whole clip is kept', () => {
  assert.deepEqual(keptRanges(edit(), words), [{ start: 9.9, end: 13.8 }]);
});

test('removed words are cut out with most of the silence around them', () => {
  const cuts = computeCuts(edit({ deleted: ['0:1', '0:2'] }), words);
  // 0.1 s of silence kept after "vi" and before "prata".
  assert.equal(cuts.length, 1);
  assert.ok(Math.abs(cuts[0].start - 10.4) < 1e-9);
  assert.ok(Math.abs(cuts[0].end - 11.1) < 1e-9);
});

test('removing the first words starts the clip just before the next one', () => {
  const kept = keptRanges(edit({ deleted: ['0:0'] }), words);
  assert.ok(Math.abs(kept[0].start - 10.3) < 1e-9); // "ska" at 10.4, 0.1 s lead-in
});

test('removing the last words lets the one before ring out', () => {
  const kept = keptRanges(edit({ deleted: ['0:5'] }), words);
  assert.ok(Math.abs(kept[kept.length - 1].end - 13.1) < 1e-9); // "om" ends 13.0, gap 0.1
});

test('fillers and long pauses can be removed', () => {
  const noFillers = computeCuts(edit({ removeFillers: true }), words);
  assert.equal(noFillers.length, 1);
  assert.ok(noFillers[0].start >= 10.7 && noFillers[0].end <= 11.2);

  const noPauses = computeCuts(edit({ removePauses: true }), words);
  // 1.2 s pause between "prata" and "om" shrinks to 0.3 s.
  assert.equal(noPauses.length, 1);
  assert.ok(Math.abs(noPauses[0].start - 11.75) < 1e-9);
  assert.ok(Math.abs(noPauses[0].end - 12.65) < 1e-9);
});

test('source and output times map both ways across a cut', () => {
  const kept = [
    { start: 10, end: 12 },
    { start: 15, end: 16 },
  ];
  assert.equal(outputDuration(kept), 3);
  assert.equal(toOutputTime(kept, 11), 1);
  assert.equal(toOutputTime(kept, 13), null);
  assert.equal(toOutputTime(kept, 15.5), 2.5);
  assert.equal(toSourceTime(kept, 2.5), 15.5);
  assert.equal(playableTime(kept, 13), 15);
  assert.equal(playableTime(kept, 16.5), null);
});

test('output words skip removed and hidden words and use the new spelling', () => {
  const e = edit({
    deleted: ['0:2'],
    words: { '0:1': { text: 'skall' }, '0:4': { hidden: true }, '0:5': { emphasis: true } },
  });
  const out = outputWords(e, words, keptRanges(e, words));
  assert.deepEqual(out.map((x) => x.text), ['vi', 'skall', 'prata', 'det']);
  assert.equal(out[3].emphasis, true);
  // "prata" comes 0.4 s earlier: the "eh" (10.8-11.1) and silence were cut.
  const cut = computeCuts(e, words)[0];
  assert.ok(Math.abs(out[2].start - (11.2 - 9.9 - (cut.end - cut.start))) < 1e-9);
});

test('clip edges set from a word leave a little room without touching the neighbours', () => {
  const window = { start: 0, end: 100 };
  assert.ok(Math.abs(startBeforeWord(words, 3, window) - 11.13) < 1e-9); // "eh" ends at 11.1
  assert.ok(Math.abs(endAfterWord(words, 3, window) - 11.95) < 1e-9); // long pause after "prata"
  assert.ok(Math.abs(endAfterWord(words, 4, window) - 13.07) < 1e-9); // "det" starts at 13.1
});

test('crop centers hold until a cut and pan in a straight line otherwise', () => {
  const keyframes = [
    { t: 0, cx: 0.2, cut: true },
    { t: 2, cx: 0.4, cut: false },
    { t: 4, cx: 0.8, cut: true },
  ];
  assert.equal(cxAt(keyframes, -1), 0.2);
  assert.ok(Math.abs(cxAt(keyframes, 1) - 0.3) < 1e-9);
  assert.equal(cxAt(keyframes, 3), 0.4);
  assert.equal(cxAt(keyframes, 5), 0.8);
});

test('manual framing overrides a stretch, then follows the speaker again', () => {
  const auto = [
    { t: 0, cx: 0.3, cut: true },
    { t: 3, cx: 0.7, cut: true },
    { t: 6, cx: 0.3, cut: true },
  ];
  const result = applyReframe(auto, [
    { t: 2, cx: 0.5 },
    { t: 5, cx: null },
  ]);
  assert.deepEqual(result, [
    { t: 0, cx: 0.3, cut: true },
    { t: 2, cx: 0.5, cut: true },
    { t: 5, cx: 0.7, cut: true }, // back to where the speaker is at 5 s
    { t: 6, cx: 0.3, cut: true },
  ]);
});

test('keyframes move onto the clip timeline, starting where the crop is at the clip start', () => {
  const keyframes = [
    { t: 100, cx: 0.2, cut: true },
    { t: 104, cx: 0.6, cut: false },
    { t: 110, cx: 0.9, cut: true },
    { t: 120, cx: 0.1, cut: true },
  ];
  const out = keyframesForRange(keyframes, 102, 111);
  // ... and the first one after the end, in case a pan runs past it.
  assert.deepEqual(out.map((k) => [k.t, k.cut]), [[0, true], [2, false], [8, true], [18, true]]);
  assert.ok(Math.abs(out[0].cx - 0.4) < 1e-9); // halfway through the pan
  assert.deepEqual(out.slice(1).map((k) => k.cx), [0.6, 0.9, 0.1]);
});
