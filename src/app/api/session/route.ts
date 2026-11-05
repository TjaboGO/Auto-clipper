import { NextResponse, type NextRequest } from 'next/server';
import { authEnabled, requestAllowed } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/** Whether the app has a password, and whether this browser is logged in. */
export async function GET(req: NextRequest) {
  return NextResponse.json({ auth: authEnabled(), loggedIn: await requestAllowed(req) });
}
