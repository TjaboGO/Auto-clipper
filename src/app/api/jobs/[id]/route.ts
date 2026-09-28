import { NextRequest, NextResponse } from 'next/server';
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
  return NextResponse.json({ job: publicJob });
}
