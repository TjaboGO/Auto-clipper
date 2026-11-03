import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildXmeml, ffmpegRate, nleRate, rateFps, timelineCuts, toFrames } from './nle';

test('a video frame rate becomes the closest standard one', () => {
  assert.deepEqual(nleRate(29.97), { timebase: 30, ntsc: true });
  assert.deepEqual(nleRate(30000 / 1001), { timebase: 30, ntsc: true });
  assert.deepEqual(nleRate(30), { timebase: 30, ntsc: false });
  assert.deepEqual(nleRate(25), { timebase: 25, ntsc: false });
  assert.deepEqual(nleRate(23.976), { timebase: 24, ntsc: true });
  assert.deepEqual(nleRate(59.94), { timebase: 60, ntsc: true });
  assert.deepEqual(nleRate(120), { timebase: 60, ntsc: false });
  assert.deepEqual(nleRate(NaN), { timebase: 30, ntsc: false });
  assert.equal(ffmpegRate({ timebase: 30, ntsc: true }), '30000/1001');
  assert.equal(ffmpegRate({ timebase: 25, ntsc: false }), '25');
  assert.ok(Math.abs(rateFps({ timebase: 24, ntsc: true }) - 23.976) < 0.001);
});

test('kept parts become cuts that sit end to end on the timeline', () => {
  const rate = { timebase: 30, ntsc: false };
  // The media starts 2 s before the clip; two words were cut out.
  const cuts = timelineCuts(
    [
      { start: 12, end: 15 },
      { start: 15.5, end: 20 },
      { start: 21, end: 22.25 },
    ],
    10,
    rate,
  );
  assert.deepEqual(cuts, [
    { in: 60, out: 150, start: 0, end: 90 },
    { in: 165, out: 300, start: 90, end: 225 },
    { in: 330, out: 368, start: 225, end: 263 },
  ]);
  // Every edge on the timeline is rounded from the exact time, so no drift.
  assert.equal(cuts[cuts.length - 1].end, toFrames(3 + 4.5 + 1.25, rate));
});

test('cuts at an NTSC rate stay in step with the exact times', () => {
  const rate = { timebase: 30, ntsc: true };
  const kept = Array.from({ length: 40 }, (_, i) => ({ start: i * 1.37, end: i * 1.37 + 0.913 }));
  const cuts = timelineCuts(kept, 0, rate);
  let at = 0;
  cuts.forEach((cut, i) => {
    assert.equal(cut.start, toFrames(at, rate));
    at += 0.913;
    assert.equal(cut.end, toFrames(at, rate));
    assert.equal(cut.out - cut.in, cut.end - cut.start);
    assert.ok(Math.abs(cut.in - kept[i].start * rateFps(rate)) <= 0.5);
    if (i > 0) assert.equal(cut.start, cuts[i - 1].end);
  });
});

test('the project XML has the cuts, the sound, stock video, graphics and music', () => {
  const xml = buildXmeml({
    name: 'Mitt klipp & mer',
    rate: { timebase: 30, ntsc: false },
    width: 1080,
    height: 1920,
    video: { file: 'video.mp4', duration: 14, start: 10, hasAudio: true },
    kept: [
      { start: 12, end: 15 },
      { start: 15.5, end: 20 },
    ],
    graphics: { file: 'grafik.mov', duration: 7.5 },
    broll: [{ file: 'broll-1.mp4', duration: 2, start: 1 }],
    music: { file: 'musik.m4a', duration: 7.5 },
  });
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<!DOCTYPE xmeml>\n<xmeml version="4">/);
  assert.match(xml, /<name>Mitt klipp &amp; mer<\/name><duration>225<\/duration>/);
  assert.match(xml, /<width>1080<\/width><height>1920<\/height>/);
  // V1: the two cuts, the first one describes the file, the second refers to it.
  assert.match(xml, /<clipitem id="video-1">.*?<start>0<\/start><end>90<\/end><in>60<\/in><out>150<\/out><file id="file-1"><name>video\.mp4<\/name><pathurl>video\.mp4<\/pathurl>/);
  assert.match(xml, /<clipitem id="video-2">.*?<start>90<\/start><end>225<\/end><in>165<\/in><out>300<\/out><file id="file-1"\/>/);
  assert.equal(xml.match(/<file id="file-1">/g)?.length, 1);
  // Its sound on two tracks, left and right, linked to the picture.
  assert.match(xml, /<clipitem id="sound-r-2">.*?<sourcetrack><mediatype>audio<\/mediatype><trackindex>2<\/trackindex><\/sourcetrack><link><linkclipref>video-2<\/linkclipref>/);
  // Stock video from 1 s for 2 s, graphics see-through over the whole clip.
  assert.match(xml, /<clipitem id="broll-1">.*?<start>30<\/start><end>90<\/end><in>0<\/in><out>60<\/out>/);
  assert.match(xml, /<clipitem id="graphics-1">.*?<start>0<\/start><end>225<\/end><in>0<\/in><out>225<\/out><alphatype>straight<\/alphatype>/);
  assert.match(xml, /<clipitem id="music-2">.*?<start>0<\/start><end>225<\/end>/);
  // Three video tracks, four audio tracks.
  const video = xml.slice(xml.indexOf('<video><format>'), xml.indexOf('<audio><numOutputChannels>'));
  const audio = xml.slice(xml.indexOf('<audio><numOutputChannels>'));
  assert.equal(video.match(/<track>/g)?.length, 3);
  assert.equal(audio.match(/<track>/g)?.length, 4);
  assert.match(xml, /<\/sequence><\/xmeml>\n$/);
});

test('a project without sound or extras is just the cut video', () => {
  const xml = buildXmeml({
    name: 'x',
    rate: { timebase: 25, ntsc: false },
    width: 1080,
    height: 1080,
    video: { file: 'video.mp4', duration: 5, start: 0, hasAudio: false },
    kept: [{ start: 0, end: 5 }],
  });
  assert.doesNotMatch(xml, /sound-|graphics|broll|music/);
  assert.match(xml, /<audio><numOutputChannels>2<\/numOutputChannels><format>.*?<\/format><\/audio>/);
  assert.match(xml, /<clipitem id="video-1">.*?<start>0<\/start><end>125<\/end>/);
});
