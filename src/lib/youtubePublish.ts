// Publishing clips to your own YouTube channel. You make a Google OAuth app
// once (its client id and secret go in GOOGLE_CLIENT_ID/SECRET or on the
// settings page), connect your account with it, and the app keeps a
// refresh token so uploads work from then on. Uploads use YouTube's
// resumable protocol, so a dropped connection picks up where it stopped.
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import { config } from './config';
import { jobStore } from './jobStore';
import { jobOutputDir } from './paths';
import { Queue } from './queue';
import { isShort, type YoutubeRequest } from './youtubeMeta';
import type { RenderedClip, YoutubeUpload } from './types';

/** Cookie that ties Google's answer to the browser that asked. */
export const YOUTUBE_STATE_COOKIE = 'ac_youtube_state';

export const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
];

// ---------------------------------------------------------------------------
// Your Google app

interface AppKeys {
  clientId: string;
  clientSecret: string;
}

export interface YoutubeAppStatus {
  configured: boolean;
  fromEnv: boolean;
  /** Not a secret (it's in every sign-in link), shown so you can tell which app it is. */
  clientId?: string;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeSecret(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function appKeys(): AppKeys | null {
  if (config.googleClientIdFromEnv && config.googleClientSecretFromEnv) {
    return { clientId: config.googleClientIdFromEnv, clientSecret: config.googleClientSecretFromEnv };
  }
  const saved = readJson<AppKeys>(config.youtubeAppFile);
  return saved?.clientId && saved.clientSecret ? saved : null;
}

export function youtubeAppStatus(): YoutubeAppStatus {
  const keys = appKeys();
  return { configured: !!keys, fromEnv: !!config.googleClientIdFromEnv, clientId: keys?.clientId };
}

export function saveYoutubeApp(raw: { clientId?: unknown; clientSecret?: unknown }): YoutubeAppStatus {
  if (config.googleClientIdFromEnv) throw new Error('Appen kommer från GOOGLE_CLIENT_ID och kan inte ändras här.');
  const clientId = typeof raw.clientId === 'string' ? raw.clientId.trim() : '';
  const clientSecret = typeof raw.clientSecret === 'string' ? raw.clientSecret.trim() : '';
  if (!/^[\w-]+\.apps\.googleusercontent\.com$/.test(clientId)) {
    throw new Error('Klient-id:t ska sluta på .apps.googleusercontent.com.');
  }
  if (!/^[\w-]{10,100}$/.test(clientSecret)) throw new Error('Klienthemligheten ser inte rätt ut.');
  writeSecret(config.youtubeAppFile, { clientId, clientSecret });
  // A new app can't use the old app's tokens.
  fs.rmSync(config.youtubeAccountFile, { force: true });
  return youtubeAppStatus();
}

export async function deleteYoutubeApp(): Promise<YoutubeAppStatus> {
  if (config.googleClientIdFromEnv) throw new Error('Appen kommer från GOOGLE_CLIENT_ID och kan inte tas bort här.');
  await disconnectYoutube();
  fs.rmSync(config.youtubeAppFile, { force: true });
  return youtubeAppStatus();
}

// ---------------------------------------------------------------------------
// Your account

interface Account {
  refreshToken: string;
  accessToken?: string;
  /** ms since epoch. */
  expiresAt?: number;
  channel: YoutubeChannel;
  connectedAt: string;
}

export interface YoutubeChannel {
  id: string;
  title: string;
  thumb?: string;
}

export interface YoutubeAccountStatus {
  connected: boolean;
  channel?: YoutubeChannel;
  connectedAt?: string;
}

function readAccount(): Account | null {
  const account = readJson<Account>(config.youtubeAccountFile);
  return account?.refreshToken ? account : null;
}

export function youtubeAccountStatus(): YoutubeAccountStatus {
  const account = readAccount();
  return account ? { connected: true, channel: account.channel, connectedAt: account.connectedAt } : { connected: false };
}

/** The address Google sends you back to: PUBLIC_URL, or where this request came in. */
export function publicOrigin(req: { headers: Headers; nextUrl: { origin: string } }): string {
  if (config.publicUrl) return config.publicUrl;
  const host = req.headers.get('x-forwarded-host')?.split(',')[0].trim() || req.headers.get('host');
  const proto = req.headers.get('x-forwarded-proto')?.split(',')[0].trim();
  return host ? `${proto || new URL(req.nextUrl.origin).protocol.replace(':', '')}://${host}` : req.nextUrl.origin;
}

export function redirectUri(origin: string): string {
  return `${origin}/api/youtube/callback`;
}

/** Sign-in attempts on their way: state -> where to come back to. */
const globalForOauth = globalThis as unknown as { __autoClipperOauth?: Map<string, { redirect: string; until: number }> };
const pending = (globalForOauth.__autoClipperOauth ??= new Map());

/** Where to send you to connect your account, and the state to remember in a cookie. */
export function startConnect(origin: string): { url: string; state: string } {
  const keys = appKeys();
  if (!keys) throw new Error('Lägg in din Google-app först.');
  const now = Date.now();
  for (const [key, value] of pending) if (value.until < now) pending.delete(key);
  const state = crypto.randomBytes(24).toString('hex');
  const redirect = redirectUri(origin);
  pending.set(state, { redirect, until: now + 10 * 60 * 1000 });
  const params = new URLSearchParams({
    client_id: keys.clientId,
    redirect_uri: redirect,
    response_type: 'code',
    scope: YOUTUBE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return { url: `${config.googleAuthUrl}?${params}`, state };
}

interface GoogleError {
  error?: string | { code?: number; message?: string; errors?: { reason?: string; message?: string }[] };
  error_description?: string;
}

function googleReason(body: GoogleError): { reason: string; message: string } {
  if (typeof body.error === 'string') return { reason: body.error, message: body.error_description || body.error };
  const first = body.error?.errors?.[0];
  return { reason: first?.reason || '', message: body.error?.message || first?.message || '' };
}

/** A Google error as something to act on. */
export function explainYoutubeError(status: number, text: string): string {
  let body: GoogleError = {};
  try {
    body = JSON.parse(text) as GoogleError;
  } catch {
    // Not JSON.
  }
  const { reason, message } = googleReason(body);
  if (reason === 'invalid_grant') return 'Kopplingen till YouTube har gått ut eller tagits bort. Koppla kontot igen under Inställningar.';
  if (reason === 'invalid_client' || reason === 'unauthorized_client') {
    return 'Google godkände inte appen. Kolla klient-id och klienthemlighet under Inställningar.';
  }
  if (reason === 'redirect_uri_mismatch') return 'Adressen att komma tillbaka till är inte tillagd i Google-appen. Lägg till den som visas under Inställningar.';
  if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
    return 'YouTube-kvoten för i dag är slut (ungefär sex uppladdningar per dag för en ny Google-app). Försök igen i morgon.';
  }
  if (reason === 'uploadLimitExceeded') return 'Kanalen har nått YouTubes gräns för uppladdningar just nu. Försök igen senare.';
  if (reason === 'youtubeSignupRequired') return 'Kontot har ingen YouTube-kanal än. Skapa en på youtube.com och försök igen.';
  if (reason === 'insufficientPermissions' || reason === 'forbidden' || status === 403) {
    return `YouTube nekade uppladdningen${message ? `: ${message}` : '.'} Koppla kontot igen och godkänn uppladdning.`;
  }
  if (reason === 'invalidTitle') return 'YouTube godkände inte titeln.';
  if (reason === 'invalidDescription') return 'YouTube godkände inte beskrivningen.';
  if (reason === 'invalidTags') return 'YouTube godkände inte taggarna.';
  if (reason === 'invalidPublishAt') return 'YouTube godkände inte tiden för publicering.';
  return `YouTube svarade med fel ${status}${message ? `: ${message}` : ''}`;
}

async function tokenRequest(params: Record<string, string>): Promise<{ access_token: string; expires_in?: number; refresh_token?: string }> {
  const res = await fetch(config.googleTokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(explainYoutubeError(res.status, text)), { status: res.status, text });
  return JSON.parse(text);
}

async function fetchChannel(accessToken: string): Promise<YoutubeChannel> {
  const res = await fetch(`${config.youtubeApiUrl}/youtube/v3/channels?part=snippet&mine=true`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(explainYoutubeError(res.status, text));
  const item = JSON.parse(text)?.items?.[0];
  if (!item?.id) throw new Error('Kontot har ingen YouTube-kanal än. Skapa en på youtube.com och försök igen.');
  return { id: String(item.id), title: String(item.snippet?.title ?? 'Din kanal'), thumb: item.snippet?.thumbnails?.default?.url };
}

/** Back from Google with a code: swap it for tokens and remember the channel. */
export async function finishConnect(code: string, state: string): Promise<YoutubeAccountStatus> {
  const keys = appKeys();
  const attempt = pending.get(state);
  pending.delete(state);
  if (!keys) throw new Error('Lägg in din Google-app först.');
  if (!attempt || attempt.until < Date.now()) throw new Error('Inloggningen tog för lång tid eller kom från fel ställe. Försök igen.');
  const tokens = await tokenRequest({
    code,
    client_id: keys.clientId,
    client_secret: keys.clientSecret,
    redirect_uri: attempt.redirect,
    grant_type: 'authorization_code',
  });
  if (!tokens.refresh_token) throw new Error('Google skickade ingen nyckel för att hålla kontot kopplat. Ta bort appens åtkomst på myaccount.google.com och försök igen.');
  const channel = await fetchChannel(tokens.access_token);
  writeSecret(config.youtubeAccountFile, {
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token,
    expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    channel,
    connectedAt: new Date().toISOString(),
  } satisfies Account);
  return youtubeAccountStatus();
}

/** Forget the account (and tell Google to drop the access, if it answers). */
export async function disconnectYoutube(): Promise<YoutubeAccountStatus> {
  const account = readAccount();
  fs.rmSync(config.youtubeAccountFile, { force: true });
  if (account) {
    await fetch(config.googleRevokeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: account.refreshToken }),
    }).catch(() => undefined);
  }
  return youtubeAccountStatus();
}

/** A working access token, refreshed when it's about to run out. */
async function accessToken(force = false): Promise<string> {
  const account = readAccount();
  const keys = appKeys();
  if (!account || !keys) throw new Error('Inget YouTube-konto är kopplat. Koppla det under Inställningar.');
  if (!force && account.accessToken && (account.expiresAt ?? 0) > Date.now() + 60_000) return account.accessToken;
  try {
    const tokens = await tokenRequest({
      refresh_token: account.refreshToken,
      client_id: keys.clientId,
      client_secret: keys.clientSecret,
      grant_type: 'refresh_token',
    });
    writeSecret(config.youtubeAccountFile, {
      ...account,
      accessToken: tokens.access_token,
      expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      refreshToken: tokens.refresh_token || account.refreshToken,
    } satisfies Account);
    return tokens.access_token;
  } catch (err) {
    // Revoked or expired for good: the account has to be connected again.
    if ((err as { text?: string }).text?.includes('invalid_grant')) fs.rmSync(config.youtubeAccountFile, { force: true });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Uploading

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A PUT with a stream (fetch can't send a known length from a stream). */
function put(url: string, headers: Record<string, string>, body: NodeJS.ReadableStream | null): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = (target.protocol === 'https:' ? https : http).request(target, { method: 'PUT', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', (err) => {
      // Stop reading the file too, or it stays open.
      (body as (NodeJS.ReadableStream & { destroy?: () => void }) | null)?.destroy?.();
      reject(err);
    });
    req.setTimeout(120_000, () => req.destroy(new Error('YouTube slutade svara.')));
    if (body) {
      body.on('error', (err) => req.destroy(err as Error));
      body.pipe(req);
    } else {
      req.end();
    }
  });
}

/** How far YouTube got with an interrupted upload (bytes it has). */
async function uploadedSoFar(sessionUrl: string, size: number, token: string): Promise<number | Reply> {
  const reply = await put(sessionUrl, { Authorization: `Bearer ${token}`, 'Content-Length': '0', 'Content-Range': `bytes */${size}` }, null);
  if (reply.status === 308) {
    const range = /bytes=0-(\d+)/.exec(String(reply.headers.range ?? ''));
    return range ? Number(range[1]) + 1 : 0;
  }
  return reply;
}

export interface UploadOptions {
  /** Waits before each retry, in ms (tests make them short). */
  retryDelays?: number[];
  onProgress?: (share: number) => void;
}

/** Upload a video file with its title, description and privacy. Returns the new video's id. */
export async function uploadToYoutube(file: string, meta: YoutubeRequest, opts: UploadOptions = {}): Promise<string> {
  const size = fs.statSync(file).size;
  const delays = opts.retryDelays ?? [2000, 5000, 10000, 20000, 40000];
  let token = await accessToken();

  // 1. Start an upload session with the video's details.
  const resource = {
    snippet: { title: meta.title, description: meta.description, tags: meta.tags, categoryId: '22' },
    status: {
      privacyStatus: meta.publishAt ? 'private' : meta.privacy,
      ...(meta.publishAt ? { publishAt: meta.publishAt } : {}),
      selfDeclaredMadeForKids: false,
    },
  };
  let sessionUrl = '';
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${config.youtubeApiUrl}/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(size),
        'X-Upload-Content-Type': 'video/mp4',
      },
      body: JSON.stringify(resource),
    });
    const text = await res.text();
    if (res.ok && res.headers.get('location')) {
      sessionUrl = res.headers.get('location') as string;
      break;
    }
    if (res.status === 401 && attempt === 0) {
      token = await accessToken(true);
      continue;
    }
    if (res.status >= 500 && attempt < delays.length) {
      await new Promise((r) => setTimeout(r, delays[attempt]));
      continue;
    }
    throw new Error(explainYoutubeError(res.status, text));
  }

  // 2. Send the file, and pick up where it stopped if the connection drops.
  let from = 0;
  for (let attempt = 0; ; attempt++) {
    let reply: Reply | null = null;
    let failure: unknown = null;
    try {
      const stream = fs.createReadStream(file, { start: from, highWaterMark: 1 << 20 });
      let sent = from;
      let last = 0;
      stream.on('data', (chunk) => {
        sent += chunk.length;
        const now = Date.now();
        if (opts.onProgress && now - last > 1000) {
          last = now;
          opts.onProgress(Math.min(0.99, sent / size));
        }
      });
      reply = await put(
        sessionUrl,
        {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'video/mp4',
          'Content-Length': String(size - from),
          ...(from > 0 ? { 'Content-Range': `bytes ${from}-${size - 1}/${size}` } : {}),
        },
        stream,
      );
    } catch (err) {
      failure = err;
    }
    if (reply && (reply.status === 200 || reply.status === 201)) {
      const id = JSON.parse(reply.body)?.id;
      if (!id) throw new Error('YouTube tog emot videon men skickade inget id.');
      opts.onProgress?.(1);
      return String(id);
    }
    if (reply && reply.status === 401 && attempt === 0) {
      token = await accessToken(true);
    } else if (reply && reply.status < 500 && reply.status !== 308) {
      throw new Error(explainYoutubeError(reply.status, reply.body));
    }
    if (attempt >= delays.length) {
      throw failure instanceof Error ? new Error(`Uppladdningen avbröts: ${failure.message}`) : new Error(explainYoutubeError(reply?.status ?? 0, reply?.body ?? ''));
    }
    await new Promise((r) => setTimeout(r, delays[attempt]));
    const sofar = await uploadedSoFar(sessionUrl, size, token).catch(() => from);
    if (typeof sofar !== 'number') {
      if (sofar.status === 200 || sofar.status === 201) {
        const id = JSON.parse(sofar.body)?.id;
        if (id) return String(id);
      }
      if (sofar.status === 404 || sofar.status === 410) throw new Error('YouTube glömde uppladdningen. Försök igen.');
      continue;
    }
    from = sofar;
  }
}

// ---------------------------------------------------------------------------
// The upload queue: one at a time, on its own (uploading is waiting on the
// network, so it shouldn't hold up rendering).

const globalForUploads = globalThis as unknown as { __autoClipperUploads?: Queue };
const uploadQueue = (globalForUploads.__autoClipperUploads ??= new Queue(1));

/** Earlier uploads kept per clip. */
const HISTORY = 20;

function setUpload(jobId: string, clipId: string, upload: YoutubeUpload): void {
  const job = jobStore.get(jobId);
  if (!job?.clips) return;
  jobStore.update(jobId, {
    clips: job.clips.map((c) => {
      if (c.id !== clipId) return c;
      // A new upload moves a finished one to the history.
      const startingOver = upload.status === 'queued' && c.youtube?.status === 'done';
      const youtubeHistory = startingOver ? [c.youtube as YoutubeUpload, ...(c.youtubeHistory ?? [])].slice(0, HISTORY) : c.youtubeHistory;
      return { ...c, youtube: upload, ...(youtubeHistory ? { youtubeHistory } : {}) };
    }),
  });
}

export function videoUrl(videoId: string, short: boolean): string {
  return short ? `https://youtube.com/shorts/${videoId}` : `https://www.youtube.com/watch?v=${videoId}`;
}

/** Queue an upload of the clip's current video. Throws if it can't start. */
export function queueYoutubeUpload(jobId: string, clip: RenderedClip, meta: YoutubeRequest, aspect?: string): YoutubeUpload {
  if (!youtubeAccountStatus().connected) throw new Error('Inget YouTube-konto är kopplat. Koppla det under Inställningar.');
  if (clip.youtube && (clip.youtube.status === 'queued' || clip.youtube.status === 'uploading')) {
    throw new Error('Klippet laddas redan upp.');
  }
  if (clip.renderState && clip.renderState.status !== 'error') throw new Error('Vänta tills klippet är renderat.');
  const source = path.join(jobOutputDir(jobId), path.basename(clip.filename));
  if (!fs.existsSync(source)) throw new Error('Klippets videofil finns inte.');
  // Keep this version even if the clip is rendered again meanwhile.
  const copy = path.join(/* turbopackIgnore: true */ config.workDir, `${jobId}-youtube-${clip.id}.mp4`);
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  fs.rmSync(copy, { force: true });
  try {
    fs.linkSync(source, copy);
  } catch {
    fs.copyFileSync(source, copy);
  }
  const base = {
    title: meta.title,
    privacy: meta.privacy,
    ...(meta.publishAt ? { publishAt: meta.publishAt } : {}),
    filename: clip.filename,
  };
  const queued: YoutubeUpload = { ...base, status: 'queued', at: new Date().toISOString() };
  setUpload(jobId, clip.id, queued);
  const short = isShort(aspect, clip.durationSec);
  uploadQueue.push(async () => {
    try {
      setUpload(jobId, clip.id, { ...base, status: 'uploading', progress: 0, at: new Date().toISOString() });
      const id = await uploadToYoutube(copy, meta, {
        onProgress: (progress) => setUpload(jobId, clip.id, { ...base, status: 'uploading', progress, at: new Date().toISOString() }),
      });
      setUpload(jobId, clip.id, { ...base, status: 'done', videoId: id, url: videoUrl(id, short), at: new Date().toISOString() });
    } catch (err) {
      console.error(`[youtube] uploading ${jobId}/${clip.id} failed:`, err);
      const message = err instanceof Error ? err.message.split('\n')[0] : String(err);
      setUpload(jobId, clip.id, { ...base, status: 'error', error: message, at: new Date().toISOString() });
    } finally {
      fs.rmSync(copy, { force: true });
    }
  });
  return queued;
}
