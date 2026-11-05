import { NextRequest, NextResponse } from 'next/server';
import { deleteYoutubeApp, saveYoutubeApp } from '@/lib/youtubePublish';

export const runtime = 'nodejs';

/** Save your Google OAuth app: `{ clientId, clientSecret }`. */
export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  try {
    return NextResponse.json({ app: saveYoutubeApp(body ?? {}) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}

export async function DELETE() {
  try {
    return NextResponse.json({ app: await deleteYoutubeApp() });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
