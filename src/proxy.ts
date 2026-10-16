// With APP_PASSWORD set, every page and API call needs a login (see
// lib/auth.ts). Uploads are left out of the matcher: the proxy would only
// pass on the first 10 MB of their body, so those routes check for
// themselves (requireAuth).
import { NextResponse, type NextRequest } from 'next/server';
import { authEnabled, requestAllowed } from '@/lib/auth';

const OPEN = ['/login', '/api/login', '/api/logout', '/api/session'];

export async function proxy(req: NextRequest) {
  if (!authEnabled()) return NextResponse.next();
  const path = req.nextUrl.pathname;
  if (OPEN.includes(path) || (await requestAllowed(req))) return NextResponse.next();
  if (path.startsWith('/api/')) return NextResponse.json({ error: 'Logga in först.' }, { status: 401 });
  const login = new URL('/login', req.url);
  if (path !== '/') login.searchParams.set('next', path + req.nextUrl.search);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|icon\\.svg|favicon\\.ico|api/jobs$|api/brand/fonts$|api/brand/logo$).*)'],
};
