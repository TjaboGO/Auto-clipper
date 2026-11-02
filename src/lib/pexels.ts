// B-roll from Pexels (https://www.pexels.com): free stock video, searched
// with your own API key. Downloaded clips are kept in storage/broll, so the
// same video is only fetched once. Pexels asks apps to credit it and the
// person who filmed; the editor and klipp.txt do.
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { Readable, Transform } from 'stream';
import type { ReadableStream as NodeReadableStream } from 'stream/web';
import { config } from './config';
import type { BrollVideo } from './edit/types';

// ---------------------------------------------------------------------------
// The key

export interface PexelsStatus {
  configured: boolean;
  fromEnv: boolean;
}

export function pexelsKey(): string {
  if (config.pexelsKeyFromEnv) return config.pexelsKeyFromEnv;
  try {
    return fs.readFileSync(config.pexelsKeyFile, 'utf8').trim();
  } catch {
    return '';
  }
}

export function pexelsStatus(): PexelsStatus {
  return { configured: pexelsKey() !== '', fromEnv: !!config.pexelsKeyFromEnv };
}

export function savePexelsKey(raw: string): PexelsStatus {
  if (config.pexelsKeyFromEnv) throw new Error('Nyckeln kommer från PEXELS_API_KEY och kan inte ändras här.');
  const key = raw.trim();
  if (!/^[A-Za-z0-9]{20,100}$/.test(key)) throw new Error('Det där ser inte ut som en Pexels-nyckel (bara bokstäver och siffror).');
  fs.mkdirSync(path.dirname(config.pexelsKeyFile), { recursive: true });
  fs.writeFileSync(config.pexelsKeyFile, key, { mode: 0o600 });
  return pexelsStatus();
}

export function deletePexelsKey(): PexelsStatus {
  if (config.pexelsKeyFromEnv) throw new Error('Nyckeln kommer från PEXELS_API_KEY och kan inte tas bort här.');
  fs.rmSync(config.pexelsKeyFile, { force: true });
  return pexelsStatus();
}

// ---------------------------------------------------------------------------
// Searching

interface PexelsFile {
  quality?: string;
  file_type?: string;
  width?: number;
  height?: number;
  link?: string;
}

interface PexelsVideo {
  id: number;
  width: number;
  height: number;
  duration: number;
  url: string;
  image: string;
  user?: { name?: string; url?: string };
  video_files?: PexelsFile[];
}

/** The file to download: MP4, as close to 1080 px on the short side as there is, never over 1920. */
export function pickFile(files: PexelsFile[]): PexelsFile | null {
  const usable = files.filter(
    (f) => f.link && f.file_type === 'video/mp4' && f.width && f.height && Math.max(f.width, f.height) <= 1920,
  );
  if (!usable.length) return null;
  const short = (f: PexelsFile) => Math.min(f.width as number, f.height as number);
  return usable.sort((a, b) => Math.abs(short(a) - 1080) - Math.abs(short(b) - 1080))[0];
}

/** A Pexels result as the editor shows and stores it (not downloaded yet). */
export function toBrollVideo(v: PexelsVideo): BrollVideo | null {
  const file = pickFile(v.video_files ?? []);
  if (!file || !Number.isInteger(v.id)) return null;
  return {
    id: `pexels-${v.id}`,
    file: `pexels-${v.id}.mp4`,
    width: file.width as number,
    height: file.height as number,
    duration: Math.max(1, Math.round(v.duration)),
    thumb: v.image,
    author: v.user?.name?.slice(0, 80) || 'Pexels',
    authorUrl: v.user?.url || 'https://www.pexels.com',
    pageUrl: v.url,
    download: file.link as string,
  };
}

function explain(status: number): Error {
  if (status === 401 || status === 403) return new Error('Pexels godkände inte nyckeln. Kolla den på inställningssidan.');
  if (status === 429) return new Error('Pexels-kvoten är slut för den här timmen. Försök igen senare.');
  return new Error(`Pexels svarade med fel ${status}.`);
}

/** Search Pexels for videos; portrait first when the clip is tall. */
export async function searchVideos(query: string, orientation: 'portrait' | 'landscape' | 'square'): Promise<BrollVideo[]> {
  const key = pexelsKey();
  if (!key) throw new Error('Lägg in en Pexels-nyckel på inställningssidan för att använda B-roll.');
  const q = query.replace(/\s+/g, ' ').trim().slice(0, 100);
  if (!q) return [];
  const url = `${config.pexelsApiUrl}/videos/search?query=${encodeURIComponent(q)}&orientation=${orientation}&per_page=15`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { Authorization: key } });
  } catch (err) {
    throw new Error(`Kunde inte nå Pexels: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw explain(res.status);
  const body = (await res.json().catch(() => ({}))) as { videos?: PexelsVideo[] };
  return (body.videos ?? []).map(toBrollVideo).filter((v): v is BrollVideo => v !== null);
}

// ---------------------------------------------------------------------------
// Downloading

const MAX_DOWNLOAD_BYTES = 150 * 1024 * 1024;

/** Where a downloaded stock video is kept, or null if `file` isn't one of ours. */
export function brollPath(file: string): string | null {
  return /^pexels-\d+\.mp4$/.test(file) ? path.join(/* turbopackIgnore: true */ config.brollDir, path.basename(file)) : null;
}

/** Download a result once (later calls find it on disk). Only Pexels' own video addresses are fetched. */
export async function downloadVideo(video: BrollVideo): Promise<string> {
  if (!brollPath(video.file)) throw new Error('Ogiltigt B-roll-klipp.');
  const target = path.join(/* turbopackIgnore: true */ config.brollDir, path.basename(video.file));
  if (fs.existsSync(/* turbopackIgnore: true */ target)) return target;
  const url = new URL(video.download);
  const allowed = url.protocol === 'https:' && (url.hostname.endsWith('.pexels.com') || url.hostname === 'pexels.com');
  const testing = config.pexelsApiUrl !== 'https://api.pexels.com' && url.origin === new URL(config.pexelsApiUrl).origin;
  if (!allowed && !testing) throw new Error('B-roll kan bara hämtas från Pexels.');
  const res = await fetch(url.href);
  if (!res.ok || !res.body) throw new Error(`Kunde inte hämta videon från Pexels (${res.status}).`);
  if (Number(res.headers.get('content-length') || 0) > MAX_DOWNLOAD_BYTES) throw new Error('Videon är för stor.');
  fs.mkdirSync(config.brollDir, { recursive: true });
  const part = `${target}.part`;
  let size = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _enc, done) {
      size += chunk.length;
      done(size > MAX_DOWNLOAD_BYTES ? new Error('Videon är för stor.') : null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body as unknown as NodeReadableStream), limit, fs.createWriteStream(part));
    fs.renameSync(part, target);
  } finally {
    fs.rmSync(part, { force: true });
  }
  return target;
}
