import { NextRequest, NextResponse } from 'next/server';
import { brandInfo, clearStyle, saveStyle } from '@/lib/brand';

export const runtime = 'nodejs';

/** Save "Min stil": `{ captions, title: { enabled, duration }, logo }` from the editor. */
export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => null);
  try {
    saveStyle(body);
    return NextResponse.json({ brand: brandInfo() });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}

export async function DELETE() {
  clearStyle();
  return NextResponse.json({ brand: brandInfo() });
}
