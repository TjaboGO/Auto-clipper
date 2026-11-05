import { NextRequest, NextResponse } from 'next/server';
import { brandInfo, musicTrack, removeMusic } from '@/lib/brand';
import { serveFile } from '@/lib/serveFile';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

/** The track, for listening in the settings and the editor's preview. */
export async function GET(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const found = musicTrack(id);
  if (!found) return NextResponse.json({ error: 'Låten finns inte.' }, { status: 404 });
  return serveFile(req, found.path, 'audio/mp4', 'private, max-age=604800, immutable');
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  if (!removeMusic(id)) return NextResponse.json({ error: 'Låten finns inte.' }, { status: 404 });
  return NextResponse.json({ brand: brandInfo() });
}
