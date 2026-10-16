import { NextRequest, NextResponse } from 'next/server';
import { clipFileBase, clipSubtitles } from '@/lib/exports';
import { jobStore } from '@/lib/jobStore';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string; clipId: string }> };

/** The clip's subtitles as a file: ?format=srt (default) or vtt. */
export async function GET(req: NextRequest, { params }: Params) {
  const { id, clipId } = await params;
  const job = jobStore.get(id);
  const index = job?.clips?.findIndex((c) => c.id === clipId) ?? -1;
  if (!job?.clips || index < 0) return NextResponse.json({ error: 'Klippet finns inte.' }, { status: 404 });
  const format = req.nextUrl.searchParams.get('format') === 'vtt' ? 'vtt' : 'srt';
  const text = clipSubtitles(id, clipId, format);
  if (text === null) return NextResponse.json({ error: 'Klippet saknar text att exportera.' }, { status: 404 });
  const name = `${clipFileBase(job.clips[index], index)}.${format}`;
  return new NextResponse(text, {
    headers: {
      'Content-Type': format === 'vtt' ? 'text/vtt; charset=utf-8' : 'application/x-subrip; charset=utf-8',
      'Content-Disposition': `attachment; filename="klipp.${format}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Cache-Control': 'no-store',
    },
  });
}
