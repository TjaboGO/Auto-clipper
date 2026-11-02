import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import { brollPath } from '@/lib/pexels';
import { serveFile } from '@/lib/serveFile';

export const runtime = 'nodejs';

/** A downloaded stock video, for the editor's preview. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const filePath = brollPath(file);
  if (!filePath || !fs.existsSync(filePath)) return NextResponse.json({ error: 'Videon finns inte.' }, { status: 404 });
  return serveFile(req, filePath, 'video/mp4', 'private, max-age=604800, immutable');
}
