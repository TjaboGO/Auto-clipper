import { NextRequest, NextResponse } from 'next/server';
import { addFont, brandInfo, MAX_FONT_BYTES } from '@/lib/brand';
import { requireAuth } from '@/lib/auth';
import { BodyTooLargeError, readLimitedBody } from '@/lib/requestBody';

export const runtime = 'nodejs';

/** Upload a font: the .ttf/.otf file as the request body, `?filename=...`. */
export async function POST(req: NextRequest) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  const filename = req.nextUrl.searchParams.get('filename') || 'typsnitt.ttf';
  try {
    const body = await readLimitedBody(req, MAX_FONT_BYTES);
    const font = addFont(body, filename);
    return NextResponse.json({ font, brand: brandInfo() }, { status: 201 });
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return NextResponse.json({ error: 'Typsnittsfilen är för stor (max 20 MB).' }, { status: 413 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
