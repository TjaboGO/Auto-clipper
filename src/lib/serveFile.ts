import fs from 'fs';
import { Readable } from 'stream';
import { NextRequest, NextResponse } from 'next/server';

function streamFile(filePath: string, range?: { start: number; end: number }): ReadableStream {
  return Readable.toWeb(fs.createReadStream(filePath, range)) as unknown as ReadableStream;
}

/**
 * Send a file with Range support (video players seek by asking for byte
 * ranges). The caller has already checked that the path is safe.
 */
export function serveFile(
  req: NextRequest,
  filePath: string,
  contentType: string,
  cacheControl = 'no-store',
): NextResponse {
  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ error: 'Filen hittades inte.' }, { status: 404 });
  }
  const { size } = fs.statSync(filePath);
  const range = req.headers.get('range');

  if (range) {
    // "bytes=START-END", "bytes=START-" or "bytes=-SUFFIX"
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    let start = NaN;
    let end = NaN;
    if (match && match[1]) {
      start = parseInt(match[1], 10);
      end = match[2] ? Math.min(parseInt(match[2], 10), size - 1) : size - 1;
    } else if (match && match[2]) {
      start = Math.max(0, size - parseInt(match[2], 10));
      end = size - 1;
    }
    if (Number.isNaN(start) || start >= size || end < start) {
      return new NextResponse(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${size}` },
      });
    }

    return new NextResponse(streamFile(filePath, { start, end }), {
      status: 206,
      headers: {
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1),
        'Content-Type': contentType,
        'Cache-Control': cacheControl,
      },
    });
  }

  return new NextResponse(streamFile(filePath), {
    status: 200,
    headers: {
      'Content-Length': String(size),
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': cacheControl,
    },
  });
}
