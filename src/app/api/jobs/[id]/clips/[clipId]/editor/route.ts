import { NextRequest, NextResponse } from 'next/server';
import { brandInfo } from '@/lib/brand';
import { ensurePreview, readPeaks } from '@/lib/editor';
import { findEditableClip } from '@/lib/editorRoutes';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string; clipId: string }> };

/**
 * Everything the editor needs for one clip: the words, framing analysis,
 * saved edit, the preview video's state (it's made on first open) and your
 * brand kit (fonts, logo, "Min stil").
 * `?only=preview` returns just the preview state, for polling;
 * `?format=webm` asks for a WebM preview (browsers without H.264).
 */
export async function GET(req: NextRequest, { params }: Params) {
  const { id, clipId } = await params;
  const found = findEditableClip(id, clipId);
  if (found instanceof NextResponse) return found;
  const { job, clip, data, edit } = found;

  const format = req.nextUrl.searchParams.get('format') === 'webm' ? 'webm' : 'mp4';
  const status = ensurePreview(job, clipId, data, {
    retry: req.nextUrl.searchParams.get('retry') === '1',
    format,
  });
  const preview = {
    ...status,
    url: status.status === 'ready' ? `/api/jobs/${id}/clips/${clipId}/proxy?format=${format}` : undefined,
    peaks: status.status === 'ready' ? readPeaks(id, clipId) : null,
  };
  if (req.nextUrl.searchParams.get('only') === 'preview') {
    return NextResponse.json({ preview });
  }

  return NextResponse.json({
    job: { id: job.id, status: job.status },
    clip,
    clips: (job.clips ?? []).map((c) => ({ id: c.id, title: c.title })),
    data,
    edit,
    preview,
    brand: brandInfo(),
  });
}
