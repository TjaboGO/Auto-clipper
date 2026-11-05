import { NextRequest, NextResponse } from 'next/server';
import { readClipEdit, readRenderedEdit } from '@/lib/editor';
import { jobStore } from '@/lib/jobStore';
import { isSafeSegment } from '@/lib/paths';
import { sanitizeYoutubeRequest, youtubeDefaults } from '@/lib/youtubeMeta';
import { queueYoutubeUpload, youtubeAccountStatus } from '@/lib/youtubePublish';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string; clipId: string }> };

function findClip(id: string, clipId: string) {
  if (!isSafeSegment(id) || !isSafeSegment(clipId)) return null;
  const job = jobStore.get(id);
  const clip = job?.clips?.find((c) => c.id === clipId);
  if (!job || !clip) return null;
  const aspect = (readRenderedEdit(id, clipId) ?? readClipEdit(id, clipId))?.aspect ?? job.options?.aspect ?? '9:16';
  return { job, clip, aspect };
}

/** What the upload form starts with, the connected channel and the latest upload. */
export async function GET(_req: NextRequest, { params }: Params) {
  const { id, clipId } = await params;
  const found = findClip(id, clipId);
  if (!found) return NextResponse.json({ error: 'Klippet finns inte.' }, { status: 404 });
  return NextResponse.json({
    defaults: youtubeDefaults(found.clip, found.aspect),
    account: youtubeAccountStatus(),
    upload: found.clip.youtube ?? null,
  });
}

/** Upload the clip: `{ title, description, tags, privacy, publishAt }`. */
export async function POST(req: NextRequest, { params }: Params) {
  const { id, clipId } = await params;
  const found = findClip(id, clipId);
  if (!found) return NextResponse.json({ error: 'Klippet finns inte.' }, { status: 404 });
  const meta = sanitizeYoutubeRequest(await req.json().catch(() => ({})));
  if (typeof meta === 'string') return NextResponse.json({ error: meta }, { status: 400 });
  try {
    return NextResponse.json({ upload: queueYoutubeUpload(id, found.clip, meta, found.aspect) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 409 });
  }
}
