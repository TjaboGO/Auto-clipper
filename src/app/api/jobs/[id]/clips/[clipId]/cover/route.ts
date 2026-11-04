import { NextRequest, NextResponse } from 'next/server';
import { makeCover } from '@/lib/cover';
import { jobStore } from '@/lib/jobStore';
import { isSafeSegment } from '@/lib/paths';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string; clipId: string }> };

/** A cover image from the moment `at` (source seconds): `{ at, title, text? }`. Returns its address. */
export async function POST(req: NextRequest, { params }: Params) {
  const { id, clipId } = await params;
  if (!isSafeSegment(id) || !isSafeSegment(clipId) || !jobStore.get(id)?.clips?.some((c) => c.id === clipId)) {
    return NextResponse.json({ error: 'Klippet finns inte.' }, { status: 404 });
  }
  const body = await req.json().catch(() => ({}));
  const at = Number(body?.at);
  if (!Number.isFinite(at) || at < 0) return NextResponse.json({ error: 'Välj en bild i klippet.' }, { status: 400 });
  try {
    const file = await makeCover(id, clipId, at, {
      title: body?.title !== false,
      text: typeof body?.text === 'string' ? body.text : undefined,
    });
    return NextResponse.json({ url: `/api/clips/${id}/${file}?v=${Date.now()}`, file });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 409 });
  }
}
