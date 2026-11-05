import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { config } from '@/lib/config';
import { isSafeSegment } from '@/lib/paths';
import { serveFile } from '@/lib/serveFile';

export const runtime = 'nodejs';

const MIME_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

/** Serve a rendered clip (or its thumbnail) with basic Range support. */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; file: string }> },
) {
  const { id, file } = await params;
  if (!isSafeSegment(id) || !isSafeSegment(file)) {
    return NextResponse.json({ error: 'Ogiltig sökväg.' }, { status: 400 });
  }
  const filePath = path.join(config.outputDir, id, file);
  const contentType = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  return serveFile(req, filePath, contentType);
}
