import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILT_IN_LOOKS, builtInLook, isLookChoice } from './looks';
import { defaultEdit, sanitizeStyle, styleOf, withStyle } from './presets';
import { captionFont } from './fonts';
import { sanitizeJobOptions } from '../jobOptions';

test('the built-in looks have their own ids and names, and valid settings', () => {
  const ids = BUILT_IN_LOOKS.map((l) => l.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(BUILT_IN_LOOKS.map((l) => l.name)).size, ids.length);
  assert.ok(BUILT_IN_LOOKS.length >= 8);
  for (const look of BUILT_IN_LOOKS) {
    assert.match(look.id, /^s-[a-z]+$/);
    assert.equal(captionFont(look.style.captions.font).id, look.style.captions.font, `${look.id} font`);
    // A look is a valid style: cleaning it up changes nothing.
    const { savedAt: _savedAt, ...clean } = sanitizeStyle(look.style) as NonNullable<ReturnType<typeof sanitizeStyle>>;
    assert.deepEqual(clean, look.style, look.id);
  }
});

test('a look gives a clip its text, pace, zoom, cuts and progress bar', () => {
  const look = builtInLook('s-energi');
  assert.ok(look);
  const clip = withStyle(defaultEdit({ start: 0, end: 20, title: 'Hej' }), { ...look.style, savedAt: '' }, false);
  assert.equal(clip.captions.preset, 'bounce');
  assert.equal(clip.captions.maxWords, 2);
  assert.equal(clip.removePauses, true);
  assert.equal(clip.removeFillers, true);
  assert.equal(clip.zoom, 'strong');
  assert.equal(clip.transition, 'flash');
  assert.equal(clip.progress.enabled, true);
  assert.equal(clip.title.enabled, true);
  // Saving the clip's look keeps the pace.
  assert.equal(styleOf(clip).removePauses, true);
});

test('a look can be picked when starting a job', () => {
  assert.equal(isLookChoice('s-podd'), true);
  assert.equal(isLookChoice('s-finns-inte'), false);
  assert.equal(sanitizeJobOptions({ captionPreset: 's-podd' }).captionPreset, 's-podd');
  assert.equal(sanitizeJobOptions({ captionPreset: 's-finns-inte' }).captionPreset, 'karaoke');
});
