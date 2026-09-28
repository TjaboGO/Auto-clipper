import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { jobOutputDir, isSafeSegment } from '@/lib/paths';

export const runtime = 'nodejs';

const MIME_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

/** Serve a rendered clip (or its thumbnail) with basic Range support. */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string; file: string } },
) {
  if (!isSafeSegment(params.id) || !isSafeSegment(params.file)) {
    return NextResponse.json({ error: 'Ogiltig sökväg.' }, { status: 400 });
  }

  const filePath = path.join(jobOutputDir(params.id), params.file);
  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ error: 'Filen hittades inte.' }, { status: 404 });
  }

  const stat = fs.statSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const range = req.headers.get('range');

  if (range) {
    const match = /bytes=(\d+)-(\d+)?/.exec(range);
    const start = match ? parseInt(match[1], 10) : 0;
    const end = match && match[2] ? parseInt(match[2], 10) : stat.size - 1;
    const chunkSize = end - start + 1;
    const nodeStream = fs.createReadStream(filePath, { start, end });
    const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;

    return new NextResponse(webStream, {
      status: 206,
      headers: {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(chunkSize),
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
      },
    });
  }

  const nodeStream = fs.createReadStream(filePath);
  const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;

  return new NextResponse(webStream, {
    status: 200,
    headers: {
      'Content-Length': String(stat.size),
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    },
  });
}
