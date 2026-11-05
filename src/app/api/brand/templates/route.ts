import { NextRequest, NextResponse } from 'next/server';
import { brandInfo, saveTemplate } from '@/lib/brand';

export const runtime = 'nodejs';

/** Save a look as a template: `{ name, style }` (the same name replaces that template). */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  try {
    const template = saveTemplate(body?.name, body?.style);
    return NextResponse.json({ template, brand: brandInfo() });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
