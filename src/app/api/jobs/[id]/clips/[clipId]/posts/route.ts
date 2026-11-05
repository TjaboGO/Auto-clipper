import { NextRequest, NextResponse } from 'next/server';
import { readEditorData } from '@/lib/editor';
import { writePosts } from '@/lib/gemini';
import { jobStore } from '@/lib/jobStore';
import { isSafeSegment } from '@/lib/paths';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string; clipId: string }> };

/** Texts to post the clip with, one per platform (written again if they exist). */
export async function POST(_req: NextRequest, { params }: Params) {
  const { id, clipId } = await params;
  const job = isSafeSegment(id) && isSafeSegment(clipId) ? jobStore.get(id) : undefined;
  const clip = job?.clips?.find((c) => c.id === clipId);
  if (!job || !clip) return NextResponse.json({ error: 'Klippet finns inte.' }, { status: 404 });
  // What's said in the clip: its words, or the transcript lines it covers.
  const words = readEditorData(id, clipId)?.words.filter((w) => w.end > clip.start && w.start < clip.end);
  const said = words?.length
    ? words.map((w) => w.text).join(' ')
    : (job.transcript ?? []).filter((s) => s.end > clip.start && s.start < clip.end).map((s) => s.text).join(' ');
  try {
    const posts = { ...(await writePosts(clip, said)), at: new Date().toISOString() };
    const latest = jobStore.get(id);
    if (latest?.clips) jobStore.update(id, { clips: latest.clips.map((c) => (c.id === clipId ? { ...c, posts } : c)) });
    return NextResponse.json({ posts });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
