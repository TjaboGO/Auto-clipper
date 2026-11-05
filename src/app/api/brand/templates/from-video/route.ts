import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import type { ReadableStream as NodeReadableStream } from 'stream/web';
import { requireAuth } from '@/lib/auth';
import { config } from '@/lib/config';
import { newStyleUpload, startStyleFromVideo } from '@/lib/styleFromVideo';
import { isDownloadableUrl } from '@/lib/youtube';

export const runtime = 'nodejs';

/** Bigger than any short you'd want to copy the style of. */
const MAX_BYTES = 500 * 1024 * 1024;

class TooLarge extends Error {}

/**
 * Make a template from a video you like: JSON `{ url, name? }` for a link
 * (TikTok, YouTube ...), or the video file itself as the body with
 * `?filename=...&name=...`. Answers with a job to follow at
 * /api/brand/templates/from-video/<id>. Not behind the proxy (it would only
 * pass the first 10 MB of an upload), so it checks the login itself.
 */
export async function POST(req: NextRequest) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  if (!config.geminiApiKey) {
    return NextResponse.json({ error: 'Servern saknar GEMINI_API_KEY, som behövs för att titta på videon.' }, { status: 500 });
  }
  const type = req.headers.get('content-type') || '';
  if (type.includes('application/json')) {
    const body = await req.json().catch(() => ({}));
    const url = typeof body?.url === 'string' ? body.url.trim() : '';
    if (!url || !isDownloadableUrl(url)) {
      return NextResponse.json({ error: 'Klistra in en länk som börjar med http:// eller https://.' }, { status: 400 });
    }
    const name = typeof body?.name === 'string' ? body.name : undefined;
    return NextResponse.json({ job: startStyleFromVideo({ url, name }) });
  }

  if (!req.body) return NextResponse.json({ error: 'Ingen video bifogad.' }, { status: 400 });
  if (Number(req.headers.get('content-length') || 0) > MAX_BYTES) {
    return NextResponse.json({ error: 'Videon är för stor (max 500 MB).' }, { status: 413 });
  }
  const params = req.nextUrl.searchParams;
  const filename = path.basename(params.get('filename') || 'video.mp4').slice(0, 200);
  const ext = (path.extname(filename).toLowerCase().match(/^\.[a-z0-9]{1,5}$/) ?? ['.mp4'])[0];
  const { id, dir } = newStyleUpload();
  const file = path.join(/* turbopackIgnore: true */ dir, `upload${ext}`);
  let bytes = 0;
  try {
    await pipeline(
      Readable.fromWeb(req.body as unknown as NodeReadableStream<Uint8Array>),
      new Transform({
        transform(chunk: Buffer, _enc, done) {
          bytes += chunk.length;
          done(bytes > MAX_BYTES ? new TooLarge() : null, chunk);
        },
      }),
      fs.createWriteStream(file),
    );
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    if (err instanceof TooLarge) return NextResponse.json({ error: 'Videon är för stor (max 500 MB).' }, { status: 413 });
    return NextResponse.json({ error: 'Uppladdningen avbröts.' }, { status: 400 });
  }
  if (bytes === 0) {
    fs.rmSync(dir, { recursive: true, force: true });
    return NextResponse.json({ error: 'Filen var tom.' }, { status: 400 });
  }
  const job = startStyleFromVideo({ id, file, from: filename.replace(/\.[^.]+$/, ''), name: params.get('name') ?? undefined });
  return NextResponse.json({ job });
}
