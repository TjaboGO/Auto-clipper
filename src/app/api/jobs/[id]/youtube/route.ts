import { NextRequest, NextResponse } from 'next/server';
import { readClipEdit, readRenderedEdit } from '@/lib/editor';
import { jobStore } from '@/lib/jobStore';
import { isSafeSegment } from '@/lib/paths';
import { sanitizeYoutubeRequest, youtubeDefaults } from '@/lib/youtubeMeta';
import { queueYoutubeUpload } from '@/lib/youtubePublish';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

const MAX_HOURS = 24 * 14;

/**
 * Schedule clips of the job on YouTube, one after the other:
 * `{ clipIds, firstAt, everyHours }`. Each gets its suggested title, text
 * and hashtags and stays private until its time.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const job = isSafeSegment(id) ? jobStore.get(id) : undefined;
  if (!job?.clips) return NextResponse.json({ error: 'Jobbet finns inte.' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const first = Date.parse(typeof body?.firstAt === 'string' ? body.firstAt : '');
  const every = Number(body?.everyHours);
  if (!Number.isFinite(first)) return NextResponse.json({ error: 'Välj när det första klippet ska ut.' }, { status: 400 });
  if (!Number.isFinite(every) || every < 1 || every > MAX_HOURS) {
    return NextResponse.json({ error: 'Välj mellan 1 timme och 14 dagar mellan klippen.' }, { status: 400 });
  }
  const wanted: string[] = Array.isArray(body?.clipIds) ? body.clipIds.filter((c: unknown) => typeof c === 'string') : [];
  const clips = job.clips.filter((c) => wanted.includes(c.id)).sort((a, b) => wanted.indexOf(a.id) - wanted.indexOf(b.id));
  if (clips.length === 0) return NextResponse.json({ error: 'Välj minst ett klipp.' }, { status: 400 });

  const scheduled: { clipId: string; publishAt: string }[] = [];
  const skipped: { clipId: string; title: string; reason: string }[] = [];
  clips.forEach((clip, i) => {
    const aspect = (readRenderedEdit(id, clip.id) ?? readClipEdit(id, clip.id))?.aspect ?? job.options?.aspect ?? '9:16';
    const publishAt = new Date(first + i * every * 3600_000).toISOString();
    const meta = sanitizeYoutubeRequest({ ...youtubeDefaults(clip, aspect), publishAt });
    if (typeof meta === 'string') {
      skipped.push({ clipId: clip.id, title: clip.title, reason: meta });
      return;
    }
    try {
      // Read again: queueing changes the job.
      const current = jobStore.get(id)?.clips?.find((c) => c.id === clip.id) ?? clip;
      queueYoutubeUpload(id, current, meta, aspect);
      scheduled.push({ clipId: clip.id, publishAt });
    } catch (err) {
      skipped.push({ clipId: clip.id, title: clip.title, reason: err instanceof Error ? err.message : String(err) });
    }
  });
  return NextResponse.json({ scheduled, skipped }, { status: scheduled.length ? 200 : 409 });
}
