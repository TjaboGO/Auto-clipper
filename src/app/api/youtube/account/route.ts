import { NextResponse } from 'next/server';
import { disconnectYoutube } from '@/lib/youtubePublish';

export const runtime = 'nodejs';

/** Disconnect the YouTube account. */
export async function DELETE() {
  return NextResponse.json({ account: await disconnectYoutube() });
}
