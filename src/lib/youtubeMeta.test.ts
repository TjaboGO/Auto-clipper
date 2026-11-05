import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTags, cleanTitle, isShort, sanitizeYoutubeRequest, youtubeDefaults } from './youtubeMeta';

test('a clip becomes a title, description and tags, with #Shorts for a Short', () => {
  const clip = { title: 'Grejen med <pengar>', caption: 'Det här ändrar allt', hashtags: ['pengar', '#tips', 'Pengar'], durationSec: 25 };
  const d = youtubeDefaults(clip, '9:16');
  assert.equal(d.title, 'Grejen med pengar');
  assert.equal(d.description, 'Det här ändrar allt\n\n#pengar #tips #Shorts');
  assert.deepEqual(d.tags, ['pengar', 'tips']);
  assert.equal(d.privacy, 'private');
  assert.equal(d.publishAt, null);
  // Wide or long: not a Short.
  assert.doesNotMatch(youtubeDefaults(clip, '16:9').description, /#Shorts/);
  assert.doesNotMatch(youtubeDefaults({ ...clip, durationSec: 240 }, '9:16').description, /#Shorts/);
  assert.equal(isShort('9:16', 180), true);
  assert.equal(isShort('9:16', 181), false);
});

test('titles and tags keep to what YouTube allows', () => {
  assert.equal(cleanTitle('  a  <b>  c '), 'a b c');
  assert.equal([...cleanTitle('å'.repeat(150))].length, 100);
  const tags = cleanTags(Array.from({ length: 100 }, (_, i) => `tagg nummer ${i}`));
  const total = tags.reduce((sum, t, i) => sum + t.length + (t.includes(' ') ? 2 : 0) + (i ? 1 : 0), 0);
  assert.ok(total <= 500 && tags.length > 10);
  assert.deepEqual(cleanTags(['#a,b', '"c"', '', '#']), ['ab', 'c']);
});

test('an upload request is checked', () => {
  const now = Date.parse('2026-11-03T12:00:00Z');
  assert.equal(sanitizeYoutubeRequest({ title: '  ' }, now), 'Videon behöver en titel.');
  const ok = sanitizeYoutubeRequest({ title: 'Hej', description: 'x'.repeat(6000), tags: ['a', 3], privacy: 'public' }, now);
  assert.ok(typeof ok !== 'string');
  assert.equal(ok.privacy, 'public');
  assert.equal(ok.description.length, 5000);
  assert.deepEqual(ok.tags, ['a']);
  // A time to publish keeps the video private until then.
  const later = sanitizeYoutubeRequest({ title: 'Hej', privacy: 'public', publishAt: '2026-11-04T08:00:00Z' }, now);
  assert.ok(typeof later !== 'string');
  assert.equal(later.privacy, 'private');
  assert.equal(later.publishAt, '2026-11-04T08:00:00.000Z');
  assert.match(String(sanitizeYoutubeRequest({ title: 'Hej', publishAt: '2026-11-03T12:01:00Z' }, now)), /fem minuter/);
  assert.match(String(sanitizeYoutubeRequest({ title: 'Hej', publishAt: 'i morgon' }, now)), /går inte att läsa/);
  assert.equal((sanitizeYoutubeRequest({ title: 'Hej', privacy: 'secret' }, now) as { privacy: string }).privacy, 'private');
});
