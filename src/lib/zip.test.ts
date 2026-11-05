import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { safeFileName, zipChunks, zipSize, type ZipEntry } from './zip';

async function build(entries: ZipEntry[]): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of zipChunks(entries)) parts.push(chunk);
  return Buffer.concat(parts);
}

test('a stored ZIP with UTF-8 names, the size known up front, checksums right', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-test-'));
  try {
    const file = path.join(dir, 'clip.bin');
    const content = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
    fs.writeFileSync(file, content);
    const entries: ZipEntry[] = [
      { name: '01 Så här gör du.mp4', path: file },
      { name: 'klipp.txt', data: Buffer.from('hej på dig\n'), modified: new Date(2026, 9, 16, 12, 30, 10) },
    ];
    const zip = await build(entries);
    assert.equal(zip.length, zipSize(entries));
    // End record: two entries, the central directory right after the data.
    const end = zip.subarray(zip.length - 22);
    assert.equal(end.readUInt32LE(0), 0x06054b50);
    assert.equal(end.readUInt16LE(10), 2);
    const dirOffset = end.readUInt32LE(16);
    assert.equal(zip.readUInt32LE(dirOffset), 0x02014b50);
    // First local header: stored, UTF-8 flag, the file's CRC and size, then its name and data.
    assert.equal(zip.readUInt32LE(0), 0x04034b50);
    assert.equal(zip.readUInt16LE(6), 0x0800);
    assert.equal(zip.readUInt16LE(8), 0);
    assert.equal(zip.readUInt32LE(14), zlib.crc32(content));
    assert.equal(zip.readUInt32LE(18), content.length);
    const nameLength = zip.readUInt16LE(26);
    assert.equal(zip.subarray(30, 30 + nameLength).toString('utf8'), '01 Så här gör du.mp4');
    assert.ok(zip.subarray(30 + nameLength, 30 + nameLength + content.length).equals(content));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('file names lose characters that break on some systems', () => {
  assert.equal(safeFileName('Vad är AI? Del 1/2: "intro"'), 'Vad är AI Del 1 2 intro');
  assert.equal(safeFileName('  ...  '), 'klipp');
  assert.equal(safeFileName('a'.repeat(200)).length, 80);
});
