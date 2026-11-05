import { NextRequest, NextResponse } from 'next/server';
import { deletePexelsKey, pexelsStatus, savePexelsKey } from '@/lib/pexels';

export const runtime = 'nodejs';

/** Whether a Pexels key is set (never the key itself). */
export async function GET() {
  return NextResponse.json({ pexels: pexelsStatus() });
}

/** Save a Pexels API key: `{ key }`. */
export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  try {
    return NextResponse.json({ pexels: savePexelsKey(typeof body?.key === 'string' ? body.key : '') });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}

export async function DELETE() {
  try {
    return NextResponse.json({ pexels: deletePexelsKey() });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
