import { NextRequest, NextResponse } from 'next/server';
import { proxyFile } from '@/lib/editor';
import { isSafeSegment } from '@/lib/paths';
import { serveFile } from '@/lib/serveFile';

export const runtime = 'nodejs';

/** The editor's preview video for a clip (a small copy of the clip and its surroundings). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; clipId: string }> }) {
  const { id, clipId } = await params;
  if (!isSafeSegment(id) || !isSafeSegment(clipId)) {
    return NextResponse.json({ error: 'Ogiltig sökväg.' }, { status: 400 });
  }
  const format = req.nextUrl.searchParams.get('format') === 'webm' ? 'webm' : 'mp4';
  return serveFile(req, proxyFile(id, clipId, format), `video/${format}`, 'private, max-age=86400');
}
