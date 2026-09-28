import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { jobStore } from '@/lib/jobStore';
import { jobWorkDir } from '@/lib/paths';
import { enqueueJob } from '@/lib/pipeline';
import { config } from '@/lib/config';
import type { Job } from '@/lib/types';

export const runtime = 'nodejs';

function clampClipCount(raw: string): number {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return config.defaultClipCount;
  return Math.min(15, Math.max(1, n));
}

/** Create a new clipping job: either an uploaded video file, or a YouTube URL. */
export async function POST(req: NextRequest) {
  try {
    if (!config.geminiApiKey) {
      return NextResponse.json(
        { error: 'Servern saknar GEMINI_API_KEY. Lägg till en nyckel i .env och starta om.' },
        { status: 500 },
      );
    }

    const contentType = req.headers.get('content-type') || '';
    const jobId = uuidv4();
    const now = new Date().toISOString();
    let clipCount = config.defaultClipCount;
    let source: Job['source'];
    let sourceVideoPath: string | undefined;

    if (contentType.includes('multipart/form-data')) {
      const form = await req.formData();
      const file = form.get('file');
      const clipCountRaw = form.get('clipCount');
      if (typeof clipCountRaw === 'string' && clipCountRaw) {
        clipCount = clampClipCount(clipCountRaw);
      }
      if (!file || typeof file === 'string') {
        return NextResponse.json({ error: 'Ingen videofil bifogad.' }, { status: 400 });
      }
      if (file.size > config.maxUploadBytes) {
        return NextResponse.json({ error: 'Filen är för stor (max 2GB).' }, { status: 400 });
      }

      const workDir = jobWorkDir(jobId);
      const ext = path.extname(file.name) || '.mp4';
      const savedPath = path.join(workDir, `source${ext}`);
      const buffer = Buffer.from(await file.arrayBuffer());
      fs.writeFileSync(savedPath, buffer);

      sourceVideoPath = savedPath;
      source = { type: 'upload', originalName: file.name };
    } else {
      const body = await req.json().catch(() => ({}));
      const url = typeof body.youtubeUrl === 'string' ? body.youtubeUrl.trim() : '';
      if (!url) {
        return NextResponse.json(
          { error: 'Ingen videofil eller video-URL angavs.' },
          { status: 400 },
        );
      }
      if (body.clipCount) clipCount = clampClipCount(String(body.clipCount));
      source = { type: 'youtube', url };
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
