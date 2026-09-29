import { NextRequest, NextResponse } from 'next/server';
import { jobStore } from '@/lib/jobStore';
import { clipLength, defaultJobOptions, sanitizeTopic } from '@/lib/jobOptions';
import { isSafeSegment } from '@/lib/paths';
import { canSearch, enqueueSearch } from '@/lib/pipeline';

export const runtime = 'nodejs';

/**
 * Find more clips in a finished job: `{ topic, clipCount, clipLength }`.
 * An empty topic means "more of the best moments". Uses the transcript the
 * job already has, so no new transcription.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSafeSegment(id)) {
    return NextResponse.json({ error: 'Ogiltigt jobb-id.' }, { status: 400 });
  }
  const job = jobStore.get(id);
  if (!job) {
    return NextResponse.json({ error: 'Jobbet hittades inte.' }, { status: 404 });
  }
  if (!canSearch(id)) {
    const busy = job.status !== 'done' && job.status !== 'error';
    return NextResponse.json(
      {
        error: busy
          ? 'Jobbet håller redan på. Vänta tills det är klart.'
          : 'Det går inte att söka i det här jobbet (källvideon eller transkriberingen finns inte kvar).',
      },
      { status: 409 },
    );
  }
  const body = await req.json().catch(() => ({}));
  const count = parseInt(String(body?.clipCount ?? 3), 10);
  enqueueSearch(id, {
    topic: sanitizeTopic(body?.topic),
    clipCount: Number.isNaN(count) ? 3 : Math.min(10, Math.max(1, count)),
    clipLength: clipLength(body?.clipLength ?? (job.options ?? defaultJobOptions()).clipLength).id,
  });
  return NextResponse.json({ queued: true }, { status: 202 });
}
