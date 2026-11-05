import { NextRequest, NextResponse } from 'next/server';
import { cookieStatus, deleteCookies, saveCookies } from '@/lib/youtube';

export const runtime = 'nodejs';

// A cookies.txt is a few kB; this is plenty.
const MAX_BYTES = 1024 * 1024;

/** Whether YouTube cookies are saved (never the cookies themselves). */
export async function GET() {
  return NextResponse.json({ cookies: cookieStatus() });
}

/** Save a cookies.txt (Netscape format), sent as the raw request body. */
export async function PUT(req: NextRequest) {
  const text = await req.text();
  if (text.length > MAX_BYTES) {
    return NextResponse.json({ error: 'Filen är för stor för att vara en cookies.txt.' }, { status: 413 });
  }
  try {
    return NextResponse.json({ cookies: saveCookies(text) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}

export async function DELETE() {
  try {
    deleteCookies();
    return NextResponse.json({ cookies: cookieStatus() });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
