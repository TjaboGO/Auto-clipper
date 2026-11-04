import { NextRequest, NextResponse } from 'next/server';
import { formatChapters } from '@/lib/chapters';
import { suggestChapters } from '@/lib/gemini';
import { jobStore } from '@/lib/jobStore';
import { isSafeSegment } from '@/lib/paths';

export const runtime = 'nodejs';
// Writing chapters for a long video can take a little while.
export const maxDuration = 120;

type Params = { params: Promise<{ id: string }> };

/** Chapters for the whole video, made from its transcript (made again if they exist). */
export async function POST(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const job = isSafeSegment(id) ? jobStore.get(id) : undefined;
  if (!job) return NextResponse.json({ error: 'Jobbet finns inte.' }, { status: 404 });
  const duration = job.sourceDurationSec ?? 0;
  if (!job.transcript?.length || !duration) {
    return NextResponse.json({ error: 'Jobbet har ingen transkribering att göra kapitel av.' }, { status: 409 });
  }
  try {
    const items = await suggestChapters(job.transcript, duration);
    if (items.length === 0) {
      return NextResponse.json({ error: 'Videon är för kort eller har för lite prat för kapitel (YouTube kräver minst tre på tio sekunder var).' }, { status: 422 });
    }
    const chapters = { items, at: new Date().toISOString() };
    jobStore.update(id, { chapters });
    return NextResponse.json({ chapters, text: formatChapters(items, duration) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
