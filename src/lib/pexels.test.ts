import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brollPath, pickFile, toBrollVideo } from './pexels';
import { brollShows, coverRect } from './edit/broll';
import { sanitizeBroll } from './edit/presets';
import type { OutputWord } from './edit/timeline';

const pexelsVideo = {
  id: 42,
  width: 1080,
  height: 1920,
  duration: 7.4,
  url: 'https://www.pexels.com/video/42/',
  image: 'https://images.pexels.com/42.jpg',
  user: { name: 'Anna', url: 'https://www.pexels.com/@anna' },
  video_files: [
    { file_type: 'video/mp4', width: 2160, height: 3840, link: 'https://videos.pexels.com/uhd.mp4' },
    { file_type: 'video/mp4', width: 540, height: 960, link: 'https://videos.pexels.com/sd.mp4' },
    { file_type: 'video/mp4', width: 1080, height: 1920, link: 'https://videos.pexels.com/hd.mp4' },
  ],
};

test('a Pexels result: the file closest to 1080p (never 4K), with credit', () => {
  assert.equal(pickFile(pexelsVideo.video_files)?.link, 'https://videos.pexels.com/hd.mp4');
  const video = toBrollVideo(pexelsVideo);
  assert.deepEqual(video, {
    id: 'pexels-42',
    file: 'pexels-42.mp4',
    width: 1080,
    height: 1920,
    duration: 7,
    thumb: 'https://images.pexels.com/42.jpg',
    author: 'Anna',
    authorUrl: 'https://www.pexels.com/@anna',
    pageUrl: 'https://www.pexels.com/video/42/',
    download: 'https://videos.pexels.com/hd.mp4',
  });
  assert.equal(brollPath('../../etc/passwd'), null);
  assert.ok(brollPath('pexels-42.mp4')?.endsWith('broll/pexels-42.mp4'));
});

test('B-roll from the editor is checked, and shown from its word for its length', () => {
  const video = toBrollVideo(pexelsVideo);
  const items = sanitizeBroll(
    [
      { video, wordId: '0:1', duration: 99, query: 'city' },
      { video: { ...video, file: 'other.mp4' }, wordId: '0:2', duration: 2 },
      { video, wordId: 'missing', duration: 2 },
    ],
    [],
    new Set(['0:1', '0:2', '0:3']),
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].duration, 8); // held to the longest allowed
  const words: OutputWord[] = [
    { id: '0:1', text: 'stad', start: 1, end: 1.5, seg: 0, emphasis: false },
    { id: '0:3', text: 'natt', start: 4, end: 4.5, seg: 0, emphasis: false },
  ];
  const shows = brollShows({ broll: [...items, { ...items[0], wordId: '0:3', duration: 3 }] }, words, 6);
  assert.deepEqual(shows.map((s) => [s.start, s.end]), [[1, 4], [4, 6]]);
  // A landscape stock video fills a tall frame from its middle.
  assert.deepEqual(coverRect({ width: 1920, height: 1080 }, { w: 1080, h: 1920 }), { x: 656.25, y: 0, w: 607.5, h: 1080 });
});
