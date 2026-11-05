import { NextRequest, NextResponse } from 'next/server';
import { duplicateClip } from '@/lib/editor';
import { ASPECT_RATIOS } from '@/lib/edit/presets';
import { isSafeSegment } from '@/lib/paths';
import type { AspectRatio } from '@/lib/edit/types';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string; clipId: string }> };

/** Copy the clip into a format: `{ aspect: "9:16" | "1:1" | "4:5" | "16:9" }`. */
export async function POST(req: NextRequest, { params }: Params) {
  const { id, clipId } = await params;
  if (!isSafeSegment(id) || !isSafeSegment(clipId)) return NextResponse.json({ error: 'Klippet finns inte.' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const aspect = ASPECT_RATIOS.includes(body?.aspect) ? (body.aspect as AspectRatio) : null;
  if (!aspect) return NextResponse.json({ error: 'Välj ett format: 9:16, 1:1, 4:5 eller 16:9.' }, { status: 400 });
  try {
    return NextResponse.json({ clip: duplicateClip(id, clipId, aspect) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 409 });
  }
}
