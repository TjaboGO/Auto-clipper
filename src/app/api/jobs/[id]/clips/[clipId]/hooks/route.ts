import { NextRequest, NextResponse } from 'next/server';
import { readClipEdit, readEditorData } from '@/lib/editor';
import { suggestHooks } from '@/lib/gemini';
import { jobStore } from '@/lib/jobStore';
import { isSafeSegment } from '@/lib/paths';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string; clipId: string }> };

/** Hook titles for the top of the clip, written by the AI. */
export async function POST(_req: NextRequest, { params }: Params) {
  const { id, clipId } = await params;
  const job = isSafeSegment(id) && isSafeSegment(clipId) ? jobStore.get(id) : undefined;
  const clip = job?.clips?.find((c) => c.id === clipId);
  const data = clip ? readEditorData(id, clipId) : null;
  const edit = clip ? readClipEdit(id, clipId) : null;
  if (!clip || !data || !edit) return NextResponse.json({ error: 'Klippet finns inte.' }, { status: 404 });
  const said = data.words.filter((w) => w.end > edit.start && w.start < edit.end).map((w) => w.text).join(' ');
  try {
    const hooks = await suggestHooks(said || clip.caption, edit.title.text || clip.title);
    if (hooks.length === 0) throw new Error('AI:n kom inte på några rubriker. Försök igen.');
    return NextResponse.json({ hooks });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
