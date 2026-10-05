import { NextRequest, NextResponse } from 'next/server';
import { brandInfo, removeFont } from '@/lib/brand';

export const runtime = 'nodejs';

/** Delete one of your fonts. Clips that used it get the default font. */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!removeFont(id)) return NextResponse.json({ error: 'Typsnittet finns inte.' }, { status: 404 });
  return NextResponse.json({ brand: brandInfo() });
}
