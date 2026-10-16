import { NextResponse, type NextRequest } from 'next/server';
import {
  authEnabled,
  checkPassword,
  loginFailed,
  loginSucceeded,
  loginWait,
  newSession,
  SESSION_COOKIE,
  SESSION_DAYS,
} from '@/lib/auth';

export const runtime = 'nodejs';

function clientAddress(req: NextRequest): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0].trim() || req.headers.get('x-real-ip') || 'local';
}

/** Log in with the app password: sets the session cookie. */
export async function POST(req: NextRequest) {
  if (!authEnabled()) return NextResponse.json({ ok: true });
  const address = clientAddress(req);
  const wait = loginWait(address);
  if (wait > 0) {
    return NextResponse.json({ error: `För många försök. Vänta ${wait} sekunder och prova igen.` }, { status: 429 });
  }
  const body = await req.json().catch(() => ({}));
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!password || !(await checkPassword(password))) {
    loginFailed(address);
    await new Promise((r) => setTimeout(r, 400));
    return NextResponse.json({ error: 'Fel lösenord.' }, { status: 401 });
  }
  loginSucceeded(address);
  const res = NextResponse.json({ ok: true });
  const secure = req.nextUrl.protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https';
  res.cookies.set(SESSION_COOKIE, await newSession(), {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
  return res;
}
