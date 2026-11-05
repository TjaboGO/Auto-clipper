import { NextResponse } from 'next/server';
import { SESSION_COOKIE } from '@/lib/auth';

/** Log out: the session cookie is removed. */
export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 });
  return res;
}
