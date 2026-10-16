import { NextRequest, NextResponse } from 'next/server';
import { jobZipEntries } from '@/lib/exports';
import { jobStore } from '@/lib/jobStore';
import { safeFileName, zipSize, zipStream } from '@/lib/zip';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

/** Every clip of the job in one ZIP, with subtitles (unless ?srt=0) and klipp.txt. */
export async function GET(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const job = jobStore.get(id);
  if (!job) return NextResponse.json({ error: 'Jobbet finns inte.' }, { status: 404 });
  if (!job.clips?.length) return NextResponse.json({ error: 'Jobbet har inga klipp än.' }, { status: 404 });
  const entries = jobZipEntries(job, { subtitles: req.nextUrl.searchParams.get('srt') !== '0' });
  let size: number;
  try {
    size = zipSize(entries);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 413 });
  }
  const source = job.source.type === 'youtube' ? job.source.title || 'youtube' : job.source.originalName.replace(/\.[^.]+$/, '');
  const name = `${safeFileName(source, 'klipp')} - klipp.zip`;
  return new NextResponse(zipStream(entries), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Length': String(size),
      'Content-Disposition': `attachment; filename="klipp.zip"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Cache-Control': 'no-store',
    },
  });
}
