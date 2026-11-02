import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { addMusic, brandInfo, MAX_MUSIC_BYTES } from '@/lib/brand';
import { BodyTooLargeError, readLimitedBody } from '@/lib/requestBody';

export const runtime = 'nodejs';

/** Upload a music track: the audio file as the request body, `?filename=...`. */
export async function POST(req: NextRequest) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  const filename = req.nextUrl.searchParams.get('filename') || 'musik.mp3';
  try {
    const track = await addMusic(await readLimitedBody(req, MAX_MUSIC_BYTES), filename);
    return NextResponse.json({ track, brand: brandInfo() }, { status: 201 });
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return NextResponse.json({ error: 'Filen är för stor (max 40 MB).' }, { status: 413 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
