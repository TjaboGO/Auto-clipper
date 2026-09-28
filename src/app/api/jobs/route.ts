import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import type { ReadableStream as NodeReadableStream } from 'stream/web';
import { jobStore } from '@/lib/jobStore';
import { jobWorkDir } from '@/lib/paths';
import { enqueueJob } from '@/lib/pipeline';
import { isDownloadableUrl } from '@/lib/youtube';
import { config } from '@/lib/config';
import type { Job } from '@/lib/types';

export const runtime = 'nodejs';

function clampClipCount(raw: unknown): number {
  const n = parseInt(String(raw), 10);
  if (Number.isNaN(n)) return config.defaultClipCount;
  return Math.min(15, Math.max(1, n));
}

class UploadTooLargeError extends Error {}

/** Stream the request body straight to disk instead of holding the video in memory. */
async function saveUpload(body: ReadableStream<Uint8Array>, filePath: string): Promise<number> {
  let bytes = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > config.maxUploadBytes) callback(new UploadTooLargeError());
      else callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(body as unknown as NodeReadableStream<Uint8Array>),
    limit,
    fs.createWriteStream(filePath),
  );
  return bytes;
}

function badRequest(error: string, status = 400) {
  return NextResponse.json({ error }, { status });
}

/**
 * Create a new clipping job. Two ways in:
 *  - JSON `{ youtubeUrl, clipCount }` for a YouTube (or other yt-dlp) link
 *  - the raw video file as the request body, with `?filename=...&clipCount=...`
 */
export async function POST(req: NextRequest) {
  try {
    if (!config.geminiApiKey) {
      return badRequest('Servern saknar GEMINI_API_KEY. Lägg till en nyckel i .env och starta om.', 500);
    }

    const contentType = req.headers.get('content-type') || '';
    const jobId = crypto.randomUUID();
    const now = new Date().toISOString();
    let clipCount = config.defaultClipCount;
    let source: Job['source'];
    let sourceVideoPath: string | undefined;

    if (contentType.includes('application/json')) {
      const body = await req.json().catch(() => ({}));
      const url = typeof body.youtubeUrl === 'string' ? body.youtubeUrl.trim() : '';
      if (!url) return badRequest('Ingen videofil eller video-URL angavs.');
      if (!isDownloadableUrl(url)) return badRequest('Länken måste börja med http:// eller https://.');
      if (body.clipCount) clipCount = clampClipCount(body.clipCount);
      source = { type: 'youtube', url };
    } else if (contentType.includes('multipart/form-data')) {
      return badRequest(
        'Skicka videon som rå fil i request-bodyn (med ?filename=...), inte som multipart/form-data.',
        415,
      );
    } else {
      const params = req.nextUrl.searchParams;
      const originalName = (params.get('filename') || 'video.mp4').slice(0, 200);
      if (params.get('clipCount')) clipCount = clampClipCount(params.get('clipCount'));
      if (!req.body) return badRequest('Ingen videofil bifogad.');
      if (Number(req.headers.get('content-length') || 0) > config.maxUploadBytes) {
        return badRequest('Filen är för stor (max 2GB).', 413);
      }

      const rawExt = path.extname(originalName).toLowerCase();
      const ext = /^\.[a-z0-9]{1,5}$/.test(rawExt) ? rawExt : '.mp4';
      const workDir = jobWorkDir(jobId);
      const savedPath = path.join(workDir, `source${ext}`);
      try {
        const bytes = await saveUpload(req.body, savedPath);
        if (bytes === 0) {
          fs.rmSync(workDir, { recursive: true, force: true });
          return badRequest('Filen är tom.');
        }
      } catch (err) {
        fs.rmSync(workDir, { recursive: true, force: true });
        if (err instanceof UploadTooLargeError) return badRequest('Filen är för stor (max 2GB).', 413);
        console.error('[api/jobs] upload failed:', err);
        return badRequest('Uppladdningen avbröts innan filen kom fram.');
      }
      sourceVideoPath = savedPath;
      source = { type: 'upload', originalName };
    }

    const job: Job = {
      id: jobId,
      createdAt: now,
      updatedAt: now,
      status: 'queued',
      source,
      clipCount,
      sourceVideoPath,
      progress: [{ step: 'queued', message: 'I kö, väntar på att börja ...', at: now }],
    };

    jobStore.create(job);
    enqueueJob(jobId);

    return NextResponse.json({ jobId }, { status: 201 });
  } catch (err) {
    console.error('[api/jobs] failed to create job:', err);
    const message = err instanceof Error ? err.message : 'Okänt fel';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** List recent jobs (used by the homepage to show history). */
export async function GET() {
  const jobs = jobStore.list().map((j) => ({
    id: j.id,
    status: j.status,
    createdAt: j.createdAt,
    source: j.source,
    clipCount: j.clipCount,
    clipsReady: j.clips?.length ?? 0,
  }));
  return NextResponse.json({ jobs });
}
