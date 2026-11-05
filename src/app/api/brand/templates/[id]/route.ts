import { NextRequest, NextResponse } from 'next/server';
import { brandInfo, removeTemplate, renameTemplate } from '@/lib/brand';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

/** Rename a template: `{ name }`. */
export async function PUT(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  try {
    renameTemplate(id, body?.name);
    return NextResponse.json({ brand: brandInfo() });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  if (!removeTemplate(id)) return NextResponse.json({ error: 'Mallen finns inte.' }, { status: 404 });
  return NextResponse.json({ brand: brandInfo() });
}
