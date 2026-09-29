import { NextRequest, NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { clipEditable, deleteJob, sourceAvailable } from '@/lib/editor';
import { canSearch } from '@/lib/pipeline';
import { jobStore } from '@/lib/jobStore';
import { isSafeSegment } from '@/lib/paths';

export const runtime = 'nodejs';

/** Poll a job's status/progress/results. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSafeSegment(id)) {
    return NextResponse.json({ error: 'Ogiltigt jobb-id.' }, { status: 400 });
  }

  const job = jobStore.get(id);
  if (!job) {
    return NextResponse.json({ error: 'Jobbet hittades inte.' }, { status: 404 });
  }

  // Don't leak internal filesystem paths to the client, and leave out the
  // full transcript - it can be large and this endpoint is polled.
  const { sourceVideoPath: _path, transcript: _transcript, ...publicJob } = job;
  return NextResponse.json({
    job: {
      ...publicJob,
      clips: job.clips?.map((clip) => ({ ...clip, editable: clipEditable(job, clip.id) })),
      sourceAvailable: sourceAvailable(job),
      sourceRetentionDays: config.sourceRetentionDays,
      canSearch: canSearch(job.id),
    },
  });
}

/** Delete a finished job with its clips and source video. */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSafeSegment(id)) {
    return NextResponse.json({ error: 'Ogiltigt jobb-id.' }, { status: 400 });
  }
  const job = jobStore.get(id);
  if (!job) {
    return NextResponse.json({ error: 'Jobbet hittades inte.' }, { status: 404 });
  }
  const busy =
    (job.status !== 'done' && job.status !== 'error') ||
    job.clips?.some((c) => c.renderState && c.renderState.status !== 'error');
  if (busy) {
    return NextResponse.json({ error: 'Jobbet håller på att renderas. Vänta tills det är klart.' }, { status: 409 });
  }
  deleteJob(id);
  return NextResponse.json({ ok: true });
}
