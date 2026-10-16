import { NextRequest, NextResponse } from 'next/server';
import { queueClipRender, writeClipEdit } from '@/lib/editor';
import { findEditableClip } from '@/lib/editorRoutes';
import { keptRanges } from '@/lib/edit/timeline';
import { sanitizeEdit } from '@/lib/edit/presets';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string; clipId: string }> };

/** Render the clip again with its edit (sent along, or the saved one). */
export async function POST(req: NextRequest, { params }: Params) {
  const { id, clipId } = await params;
  const found = findEditableClip(id, clipId);
  if (found instanceof NextResponse) return found;
  const { data, edit: saved } = found;

  const body = await req.json().catch(() => null);
  const edit =
    body && typeof body === 'object'
      ? sanitizeEdit(body, { window: data.window, wordIds: new Set(data.words.map((w) => w.id)), fallback: saved })
      : saved;
  if (keptRanges(edit, data.words).length === 0) {
    return NextResponse.json({ error: 'Allt är bortklippt. Återställ några ord först.' }, { status: 400 });
  }
  writeClipEdit(id, clipId, edit);
  if (!queueClipRender(id, clipId)) {
    return NextResponse.json({ error: 'Klippet renderas redan.' }, { status: 409 });
  }
  return NextResponse.json({ queued: true, edit }, { status: 202 });
}
