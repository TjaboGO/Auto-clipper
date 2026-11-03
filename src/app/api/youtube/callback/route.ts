import { NextRequest, NextResponse } from 'next/server';
import { finishConnect, publicOrigin, YOUTUBE_STATE_COOKIE } from '@/lib/youtubePublish';

export const runtime = 'nodejs';

/** Back from Google: keep the account, then go to the settings page. */
export async function GET(req: NextRequest) {
  const origin = publicOrigin(req);
  const params = req.nextUrl.searchParams;
  const state = params.get('state') ?? '';
  const code = params.get('code') ?? '';
  let error = '';
  if (params.get('error')) {
    error = params.get('error') === 'access_denied' ? 'Du godkände inte kopplingen.' : `Google svarade: ${params.get('error')}`;
  } else if (!state || state !== req.cookies.get(YOUTUBE_STATE_COOKIE)?.value || !code) {
    error = 'Inloggningen kom från fel ställe eller tog för lång tid. Försök igen.';
  } else {
    try {
      await finishConnect(code, state);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }
  const res = NextResponse.redirect(
    `${origin}/settings?${error ? `youtube_error=${encodeURIComponent(error)}` : 'youtube=connected'}#publicera`,
  );
  res.cookies.set(YOUTUBE_STATE_COOKIE, '', { path: '/api/youtube', maxAge: 0 });
  return res;
}
