import { NextRequest, NextResponse } from 'next/server';
import { clipFileBase } from '@/lib/exports';
import { jobStore } from '@/lib/jobStore';
import { projectEntries, projectState, queueProjectBuild } from '@/lib/nleExport';
import { isSafeSegment } from '@/lib/paths';
import { zipSize, zipStream } from '@/lib/zip';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string; clipId: string }> };

function findClip(id: string, clipId: string) {
  if (!isSafeSegment(id) || !isSafeSegment(clipId)) return null;
  const job = jobStore.get(id);
  const index = job?.clips?.findIndex((c) => c.id === clipId) ?? -1;
  return job?.clips && index >= 0 ? { job, clip: job.clips[index], index } : null;
}

/**
 * The clip as a project for Premiere Pro and DaVinci Resolve: ?status for
 * how the build is going, otherwise the ZIP (once it's built).
 */
export async function GET(req: NextRequest, { params }: Params) {
  const { id, clipId } = await params;
  const found = findClip(id, clipId);
  if (!found) return NextResponse.json({ error: 'Klippet finns inte.' }, { status: 404 });
  const state = projectState(id, clipId);
  if (req.nextUrl.searchParams.has('status')) return NextResponse.json(state);
  const entries = state.status === 'ready' ? projectEntries(id, clipId) : null;
  if (!entries) return NextResponse.json({ error: 'Projektet är inte byggt än.', ...state }, { status: 409 });
  let size: number;
  try {
    size = zipSize(entries);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 413 });
  }
  const name = `${clipFileBase(found.clip, found.index)} - projekt.zip`;
  return new NextResponse(zipStream(entries), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Length': String(size),
      'Content-Disposition': `attachment; filename="projekt.zip"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Cache-Control': 'no-store',
    },
  });
}

/** Start building the project. */
export async function POST(_req: NextRequest, { params }: Params) {
  const { id, clipId } = await params;
  if (!findClip(id, clipId)) return NextResponse.json({ error: 'Klippet finns inte.' }, { status: 404 });
  return NextResponse.json(queueProjectBuild(id, clipId));
}
