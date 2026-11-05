import { NextRequest, NextResponse } from 'next/server';
import { suggestClipBroll } from '@/lib/brollSuggest';
import { findEditableClip } from '@/lib/editorRoutes';
import { sanitizeEdit } from '@/lib/edit/presets';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string; clipId: string }> };

/** AI B-roll for the clip: `{ edit }` in, `{ items }` out (the editor adds them to the edit). */
export async function POST(req: NextRequest, { params }: Params) {
  const { id, clipId } = await params;
  const found = findEditableClip(id, clipId);
  if (found instanceof NextResponse) return found;
  const body = await req.json().catch(() => null);
  const edit = sanitizeEdit(body?.edit ?? {}, {
    window: found.data.window,
    wordIds: new Set(found.data.words.map((w) => w.id)),
    fallback: found.edit,
  });
  try {
    const items = await suggestClipBroll(found.data.words, edit);
    if (items.length === 0) return NextResponse.json({ error: 'Hittade ingen B-roll som passar klippet.' }, { status: 502 });
    return NextResponse.json({ items });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
