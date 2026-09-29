import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultJobOptions, formatClock, parseTime, sanitizeJobOptions } from './jobOptions';

test('valid options come through, bad ones fall back to the defaults', () => {
  const good = {
    clipLength: 'medium',
    aspect: '1:1',
    captionPreset: 'box',
    keywords: false,
    topic: '  pengar  och   sparande ',
    range: { start: 60, end: 600 },
  };
  assert.deepEqual(sanitizeJobOptions(good), { ...good, topic: 'pengar och sparande' });
  assert.deepEqual(
    sanitizeJobOptions({ clipLength: 'forever', aspect: '3:2', captionPreset: 'comic', keywords: 'yes', topic: 42 }),
    defaultJobOptions(),
  );
  assert.deepEqual(sanitizeJobOptions('nonsense'), defaultJobOptions());
});

test('a part of the video must be at least 10 seconds', () => {
  assert.equal(sanitizeJobOptions({ range: { start: 30, end: 35 } }).range, null);
  assert.equal(sanitizeJobOptions({ range: { start: -5, end: 100 } }).range?.start, 0);
  assert.equal(sanitizeJobOptions({ range: { end: 'x' } }).range, null);
});

test('times are read and written as m:ss', () => {
  assert.equal(parseTime('12:30'), 750);
  assert.equal(parseTime('1:02:05'), 3725);
  assert.equal(parseTime('90'), 90);
  assert.equal(parseTime('12.30'), null);
  assert.equal(parseTime(''), null);
  assert.equal(formatClock(750), '12:30');
  assert.equal(formatClock(3725), '1:02:05');
});
