import { NextRequest, NextResponse } from 'next/server';
import { publicOrigin, startConnect, YOUTUBE_STATE_COOKIE } from '@/lib/youtubePublish';

export const runtime = 'nodejs';

/** Off to Google to connect your YouTube account. */
export async function GET(req: NextRequest) {
  const origin = publicOrigin(req);
  try {
    const { url, state } = startConnect(origin);
    const res = NextResponse.redirect(url);
    res.cookies.set(YOUTUBE_STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: 'lax',
      secure: origin.startsWith('https:'),
      path: '/api/youtube',
      maxAge: 600,
    });
    return res;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.redirect(`${origin}/settings?youtube_error=${encodeURIComponent(message)}#publicera`);
  }
}
