import { NextRequest, NextResponse } from 'next/server';
import { downloadVideo } from '@/lib/pexels';
import { sanitizeBrollVideo } from '@/lib/edit/presets';

export const runtime = 'nodejs';

/** Fetch a search result to the server (once), so it can be previewed and rendered: `{ video }`. */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const video = sanitizeBrollVideo(body?.video);
  if (!video) return NextResponse.json({ error: 'Ogiltigt B-roll-klipp.' }, { status: 400 });
  try {
    await downloadVideo(video);
    return NextResponse.json({ video });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
