import { NextRequest, NextResponse } from 'next/server';
import { publicOrigin, redirectUri, youtubeAccountStatus, youtubeAppStatus } from '@/lib/youtubePublish';

export const runtime = 'nodejs';

/** Publishing to YouTube: is the Google app set, which channel is connected, and the address to add in Google. */
export async function GET(req: NextRequest) {
  return NextResponse.json({
    app: youtubeAppStatus(),
    account: youtubeAccountStatus(),
    redirectUri: redirectUri(publicOrigin(req)),
  });
}
