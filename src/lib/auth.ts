// A password for the whole app (APP_PASSWORD). Logging in gives a signed
// cookie that lasts 30 days; scripts can send the password as a bearer
// token instead. Plain Web Crypto, so it runs in the proxy and in routes
// alike. Without APP_PASSWORD the app is open, as before.

export const SESSION_COOKIE = 'ac_session';
export const SESSION_DAYS = 30;

const encoder = new TextEncoder();

export function appPassword(): string {
  return process.env.APP_PASSWORD || '';
}

export function authEnabled(): boolean {
  return appPassword() !== '';
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmac(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return hex(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message)));
}

/** The key sessions are signed with: changing the password logs everyone out. */
function sessionKey(): string {
  return process.env.APP_SESSION_SECRET || `auto-clipper-session:${appPassword()}`;
}

/** Same length strings compared without stopping at the first difference. */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Is this the password? (Both sides hashed first, so the time taken says nothing.) */
export async function checkPassword(given: string): Promise<boolean> {
  if (!authEnabled()) return true;
  const key = 'auto-clipper-password';
  return sameText(await hmac(key, given), await hmac(key, appPassword()));
}

/** A new session cookie value: when it runs out, and a signature. */
export async function newSession(now = Date.now()): Promise<string> {
  const expires = now + SESSION_DAYS * 24 * 60 * 60 * 1000;
  return `${expires}.${await hmac(sessionKey(), String(expires))}`;
}

export async function validSession(value: string | undefined, now = Date.now()): Promise<boolean> {
  if (!value) return false;
  const [expires, signature] = value.split('.');
  if (!expires || !signature || !/^\d+$/.test(expires) || Number(expires) < now) return false;
  return sameText(signature, await hmac(sessionKey(), expires));
}

/** Whether a request may go on: auth off, a valid session cookie, or the password as a bearer token. */
export async function requestAllowed(req: { headers: Headers; cookies: { get(name: string): { value: string } | undefined } }): Promise<boolean> {
  if (!authEnabled()) return true;
  if (await validSession(req.cookies.get(SESSION_COOKIE)?.value)) return true;
  const bearer = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '')?.[1];
  return !!bearer && (await checkPassword(bearer));
}

/**
 * For routes the proxy leaves alone (uploads: it would only pass on their
 * first 10 MB): a 401 response if the request isn't allowed, else null.
 */
export async function requireAuth(req: Parameters<typeof requestAllowed>[0]): Promise<Response | null> {
  if (await requestAllowed(req)) return null;
  return Response.json({ error: 'Logga in först.' }, { status: 401 });
}

// Wrong passwords: after a few, each try from the same address has to wait
// longer (in memory, per server process).
const failures = new Map<string, { count: number; until: number }>();
const FREE_TRIES = 5;

/** Seconds to wait before this address may try again (0 = go ahead). */
export function loginWait(address: string, now = Date.now()): number {
  const entry = failures.get(address);
  return entry && entry.until > now ? Math.ceil((entry.until - now) / 1000) : 0;
}

export function loginFailed(address: string, now = Date.now()): void {
  const entry = failures.get(address) ?? { count: 0, until: 0 };
  entry.count++;
  if (entry.count >= FREE_TRIES) entry.until = now + Math.min(300, 2 ** (entry.count - FREE_TRIES + 1)) * 1000;
  failures.set(address, entry);
  if (failures.size > 10000) failures.clear(); // don't grow forever
}

export function loginSucceeded(address: string): void {
  failures.delete(address);
}
