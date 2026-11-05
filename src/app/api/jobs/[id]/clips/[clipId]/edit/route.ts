import { NextRequest, NextResponse } from 'next/server';
import { writeClipEdit } from '@/lib/editor';
import { findEditableClip } from '@/lib/editorRoutes';
import { sanitizeEdit } from '@/lib/edit/presets';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string; clipId: string }> };

/** Save the editor's changes (autosave). Invalid parts keep their saved values. */
export async function PUT(req: NextRequest, { params }: Params) {
  const { id, clipId } = await params;
  const found = findEditableClip(id, clipId);
  if (found instanceof NextResponse) return found;
  const { data, edit: saved } = found;

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Ogiltig redigering.' }, { status: 400 });
  }
  const edit = sanitizeEdit(body, {
    window: data.window,
    wordIds: new Set(data.words.map((w) => w.id)),
    fallback: saved,
  });
  writeClipEdit(id, clipId, edit);
  return NextResponse.json({ edit });
}
