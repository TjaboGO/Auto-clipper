// A small ZIP writer for "download all clips": files are stored as they
// are (video doesn't compress), streamed one after the other, so nothing
// big is held in memory. Each file is read once for its checksum and once
// for the data, which keeps the archive plain (no data descriptors) and
// lets the size be known up front.
import fs from 'fs';
import zlib from 'zlib';

export interface ZipEntry {
  /** Path inside the archive (UTF-8). */
  name: string;
  /** A file on disk ... */
  path?: string;
  /** ... or the contents. */
  data?: Buffer;
  modified?: Date;
}

const LOCAL_HEADER = 30;
const CENTRAL_HEADER = 46;
const END_RECORD = 22;
const MAX_ZIP32 = 0xffffffff;

let table: Uint32Array | null = null;
function crc32Fallback(buf: Buffer, crc = 0): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = ~crc >>> 0;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

const crc32 = (buf: Buffer, crc = 0): number =>
  typeof zlib.crc32 === 'function' ? zlib.crc32(buf, crc) : crc32Fallback(buf, crc);

function entrySize(entry: ZipEntry): number {
  return entry.data ? entry.data.length : fs.statSync(entry.path as string).size;
}

/** The archive's size in bytes, before writing it. Throws if it would need ZIP64 (over 4 GB). */
export function zipSize(entries: ZipEntry[]): number {
  let total = END_RECORD;
  for (const e of entries) {
    const name = Buffer.byteLength(e.name);
    total += LOCAL_HEADER + name + entrySize(e) + CENTRAL_HEADER + name;
  }
  if (total > MAX_ZIP32) throw new Error('Klippen är tillsammans för stora för en ZIP-fil (över 4 GB).');
  return total;
}

/** Date and time the way ZIP stores them (local time, two-second steps). */
function dosTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

async function* chunks(entry: ZipEntry): AsyncGenerator<Buffer> {
  if (entry.data) {
    yield entry.data;
    return;
  }
  for await (const chunk of fs.createReadStream(entry.path as string, { highWaterMark: 1 << 20 })) yield chunk as Buffer;
}

async function checksum(entry: ZipEntry): Promise<number> {
  let crc = 0;
  for await (const chunk of chunks(entry)) crc = crc32(chunk, crc);
  return crc;
}

/** The archive, written as it's read. */
export async function* zipChunks(entries: ZipEntry[]): AsyncGenerator<Buffer> {
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const size = entrySize(entry);
    const crc = await checksum(entry);
    const modified = entry.modified ?? (entry.path ? fs.statSync(entry.path).mtime : new Date());
    const { time, date } = dosTime(modified);
    const flags = 0x0800; // names are UTF-8

    const local = Buffer.alloc(LOCAL_HEADER);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    yield Buffer.concat([local, name]);
    let written = 0;
    for await (const chunk of chunks(entry)) {
      written += chunk.length;
      yield chunk;
    }
    if (written !== size) throw new Error(`${entry.name} ändrades medan ZIP-filen skrevs.`);

    const header = Buffer.alloc(CENTRAL_HEADER);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, 2.0
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(flags, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(date, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(size, 20);
    header.writeUInt32LE(size, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(0, 30); // extra
    header.writeUInt16LE(0, 32); // comment
    header.writeUInt16LE(0, 34); // disk
    header.writeUInt16LE(0, 36); // internal attributes
    header.writeUInt32LE((0o100644 << 16) >>> 0, 38); // -rw-r--r--
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += LOCAL_HEADER + name.length + size;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(END_RECORD);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  yield Buffer.concat([directory, end]);
}

/** A web stream of the archive, for a Response. */
export function zipStream(entries: ZipEntry[]): ReadableStream<Uint8Array> {
  const iterator = zipChunks(entries);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await iterator.next();
        if (done) controller.close();
        else controller.enqueue(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel() {
      await iterator.return(undefined);
    },
  });
}

/** A file name that works on every system: no slashes or reserved characters, not too long. */
export function safeFileName(name: string, fallback = 'klipp'): string {
  const clean = name
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80)
    .trim();
  return clean || fallback;
}
