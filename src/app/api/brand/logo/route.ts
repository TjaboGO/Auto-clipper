import { NextRequest, NextResponse } from 'next/server';
import { brandInfo, logoFile, MAX_LOGO_BYTES, removeLogo, setLogo } from '@/lib/brand';
import { BodyTooLargeError, readLimitedBody } from '@/lib/requestBody';
import { serveFile } from '@/lib/serveFile';

export const runtime = 'nodejs';

/** The logo image. Asked for with ?v=<version>, so it can be cached for good. */
export async function GET(req: NextRequest) {
  if (!brandInfo().logo) return NextResponse.json({ error: 'Ingen logga uppladdad.' }, { status: 404 });
  const cache = req.nextUrl.searchParams.get('v') ? 'public, max-age=31536000, immutable' : 'no-store';
  return serveFile(req, logoFile(), 'image/png', cache);
}

/** Upload a logo (PNG, JPEG or WebP) as the request body. */
export async function POST(req: NextRequest) {
  try {
    const logo = await setLogo(await readLimitedBody(req, MAX_LOGO_BYTES));
    return NextResponse.json({ logo, brand: brandInfo() }, { status: 201 });
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return NextResponse.json({ error: 'Bilden är för stor (max 10 MB).' }, { status: 413 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}

export async function DELETE() {
  removeLogo();
  return NextResponse.json({ brand: brandInfo() });
}
