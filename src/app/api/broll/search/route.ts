import { NextRequest, NextResponse } from 'next/server';
import { searchVideos } from '@/lib/pexels';

export const runtime = 'nodejs';

/** Search Pexels: `?q=...&orientation=portrait|landscape|square`. */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get('q') ?? '';
  const raw = req.nextUrl.searchParams.get('orientation');
  const orientation = raw === 'landscape' || raw === 'square' ? raw : 'portrait';
  try {
    return NextResponse.json({ videos: await searchVideos(q, orientation) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
