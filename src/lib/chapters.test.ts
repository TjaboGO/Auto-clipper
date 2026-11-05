import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chapterTime, cleanChapters, cleanPosts, formatChapters } from './chapters';

test('chapters start at 0, are sorted, ten seconds apart, and at least three', () => {
  const raw = [
    { start: 125.4, title: '  Pengar   och tur ' },
    { start: 3, title: 'Intro' },
    { start: 130, title: 'För nära' },
    { start: 400, title: 'Slutet' },
    { start: 595, title: 'För sent' },
    { start: 'x', title: 'Trasig' },
    { start: 200, title: '' },
  ];
  assert.deepEqual(cleanChapters(raw, 600), [
    { start: 0, title: 'Intro' },
    { start: 125, title: 'Pengar och tur' },
    { start: 400, title: 'Slutet' },
  ]);
  // Too few left: none (YouTube ignores fewer than three).
  assert.deepEqual(cleanChapters([{ start: 0, title: 'A' }, { start: 50, title: 'B' }], 600), []);
  assert.deepEqual(cleanChapters('nope', 600), []);
});

test('chapters are written the way YouTube reads them', () => {
  assert.equal(chapterTime(0, false), '0:00');
  assert.equal(chapterTime(605, false), '10:05');
  assert.equal(chapterTime(3725, true), '1:02:05');
  assert.equal(chapterTime(65, true), '0:01:05');
  assert.equal(
    formatChapters([{ start: 0, title: 'Intro' }, { start: 95, title: 'Mitten' }, { start: 300, title: 'Slut' }], 400),
    '0:00 Intro\n1:35 Mitten\n5:00 Slut',
  );
});

test('post texts: one per platform, X within 280 characters', () => {
  const long = `${'ord '.repeat(100)}slut`;
  const posts = cleanPosts({ tiktok: ' Kolla! #pengar ', instagram: 'Rad 1\r\n\r\n\r\n\r\nRad 2', youtube: 'Titel #Shorts', linkedin: 'Lärdom.', x: long });
  assert.ok(posts);
  assert.equal(posts.tiktok, 'Kolla! #pengar');
  assert.equal(posts.instagram, 'Rad 1\n\nRad 2');
  assert.ok([...posts.x].length <= 280);
  assert.match(posts.x, /ord$/);
  assert.equal(cleanPosts({ tiktok: 'a', instagram: 'b', youtube: 'c', linkedin: 'd' }), null);
  assert.equal(cleanPosts(null), null);
});
