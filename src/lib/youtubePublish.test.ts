import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { config } from './config';
import {
  disconnectYoutube,
  explainYoutubeError,
  finishConnect,
  saveYoutubeApp,
  startConnect,
  uploadToYoutube,
  youtubeAccountStatus,
  youtubeAppStatus,
} from './youtubePublish';

// A pretend Google: tokens, the channel, and a resumable upload that
// drops the connection once in the middle.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-youtube-'));
const video = path.join(dir, 'clip.mp4');
const content = Buffer.alloc(600 * 1024);
for (let i = 0; i < content.length; i++) content[i] = (i * 31) % 251;

let server: http.Server;
let base = '';
const seen: { tokens: string[]; resource?: Record<string, unknown>; auth: string[] } = { tokens: [], auth: [] };
let received = Buffer.alloc(0);
let drops = 0;
let quota = false;

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

before(async () => {
  fs.writeFileSync(video, content);
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', base);
    if (url.pathname === '/token') {
      const form = new URLSearchParams((await readBody(req)).toString());
      seen.tokens.push(form.get('grant_type') ?? '');
      res.setHeader('Content-Type', 'application/json');
      if (form.get('grant_type') === 'authorization_code') {
        if (form.get('code') !== 'good-code' || !form.get('redirect_uri')?.endsWith('/api/youtube/callback')) {
          res.statusCode = 400;
          return res.end(JSON.stringify({ error: 'invalid_grant' }));
        }
        return res.end(JSON.stringify({ access_token: 'first', refresh_token: 'refresh-1', expires_in: 3600 }));
      }
      return res.end(JSON.stringify({ access_token: 'fresh', expires_in: 3600 }));
    }
    if (url.pathname === '/revoke') return res.end('{}');
    if (url.pathname === '/youtube/v3/channels') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ items: [{ id: 'UC123', snippet: { title: 'Min kanal' } }] }));
    }
    if (url.pathname === '/upload/youtube/v3/videos' && req.method === 'POST') {
      seen.auth.push(req.headers.authorization ?? '');
      seen.resource = JSON.parse((await readBody(req)).toString());
      if (quota) {
        res.statusCode = 403;
        return res.end(JSON.stringify({ error: { code: 403, message: 'quota', errors: [{ reason: 'quotaExceeded' }] } }));
      }
      if (req.headers.authorization !== 'Bearer fresh') {
        res.statusCode = 401;
        return res.end('{}');
      }
      res.setHeader('Location', `${base}/session/1`);
      return res.end();
    }
    if (url.pathname === '/session/1' && req.method === 'PUT') {
      const range = String(req.headers['content-range'] ?? '');
      if (range.startsWith('bytes */')) {
        res.statusCode = 308;
        if (received.length) res.setHeader('Range', `bytes=0-${received.length - 1}`);
        return res.end();
      }
      const start = range ? Number(/bytes (\d+)-/.exec(range)?.[1]) : 0;
      assert.equal(start, received.length);
      req.on('data', (chunk: Buffer) => {
        received = Buffer.concat([received, chunk]);
        // The first time, the connection drops a third of the way in.
        if (drops === 0 && received.length > content.length / 3) {
          drops++;
          req.socket.destroy();
        }
      });
      req.on('end', () => {
        if (received.length < content.length) return;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ id: 'video-42', status: { uploadStatus: 'uploaded' } }));
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  Object.assign(config, {
    youtubeAppFile: path.join(dir, 'youtube-app.json'),
    youtubeAccountFile: path.join(dir, 'youtube-account.json'),
    googleClientIdFromEnv: '',
    googleClientSecretFromEnv: '',
    googleAuthUrl: `${base}/auth`,
    googleTokenUrl: `${base}/token`,
    googleRevokeUrl: `${base}/revoke`,
    youtubeApiUrl: base,
  });
});

after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('your Google app is checked and saved privately', () => {
  assert.throws(() => saveYoutubeApp({ clientId: 'nope', clientSecret: 'GOCSPX-abcdefghijkl' }), /googleusercontent/);
  assert.throws(() => saveYoutubeApp({ clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'x' }), /hemligheten/);
  const status = saveYoutubeApp({ clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-abcdefghijkl' });
  assert.deepEqual(status, { configured: true, fromEnv: false, clientId: '123-abc.apps.googleusercontent.com' });
  assert.equal(fs.statSync(config.youtubeAppFile).mode & 0o777, 0o600);
  assert.deepEqual(youtubeAppStatus(), status);
});

test('connecting sends you to Google and keeps the channel', async () => {
  const { url, state } = startConnect('https://clips.example.com');
  const params = new URL(url).searchParams;
  assert.equal(params.get('redirect_uri'), 'https://clips.example.com/api/youtube/callback');
  assert.equal(params.get('access_type'), 'offline');
  assert.match(params.get('scope') ?? '', /youtube\.upload/);
  assert.equal(params.get('state'), state);
  // A state that wasn't handed out is refused.
  await assert.rejects(finishConnect('good-code', 'made-up'), /fel ställe/);
  const second = startConnect('https://clips.example.com');
  const account = await finishConnect('good-code', second.state);
  assert.equal(account.connected, true);
  assert.equal(account.channel?.title, 'Min kanal');
  assert.equal(fs.statSync(config.youtubeAccountFile).mode & 0o777, 0o600);
  // The state works only once.
  await assert.rejects(finishConnect('good-code', second.state), /fel ställe/);
});

test('an upload refreshes the token, survives a dropped connection and returns the id', async () => {
  // The token from connecting has "run out".
  const account = JSON.parse(fs.readFileSync(config.youtubeAccountFile, 'utf8'));
  fs.writeFileSync(config.youtubeAccountFile, JSON.stringify({ ...account, expiresAt: Date.now() - 1000 }));
  const progress: number[] = [];
  const id = await uploadToYoutube(
    video,
    { title: 'Hej', description: 'Text', tags: ['a'], privacy: 'private', publishAt: '2026-12-01T08:00:00.000Z' },
    { retryDelays: [20, 20, 20], onProgress: (p) => progress.push(p) },
  );
  assert.equal(id, 'video-42');
  assert.equal(drops, 1);
  assert.ok(received.equals(content), 'the file arrives whole');
  assert.ok(seen.tokens.includes('refresh_token'));
  assert.deepEqual(seen.resource, {
    snippet: { title: 'Hej', description: 'Text', tags: ['a'], categoryId: '22' },
    status: { privacyStatus: 'private', publishAt: '2026-12-01T08:00:00.000Z', selfDeclaredMadeForKids: false },
  });
  assert.equal(progress[progress.length - 1], 1);
});

test('YouTube errors become something to act on', async () => {
  quota = true;
  await assert.rejects(
    uploadToYoutube(video, { title: 'Hej', description: '', tags: [], privacy: 'public', publishAt: null }, { retryDelays: [] }),
    /kvoten för i dag är slut/,
  );
  quota = false;
  assert.match(explainYoutubeError(400, JSON.stringify({ error: 'invalid_grant' })), /Koppla kontot igen/);
  assert.match(explainYoutubeError(400, JSON.stringify({ error: 'redirect_uri_mismatch' })), /Adressen/);
  assert.match(explainYoutubeError(500, 'oops'), /fel 500/);
});

test('disconnecting forgets the account', async () => {
  assert.equal(youtubeAccountStatus().connected, true);
  assert.deepEqual(await disconnectYoutube(), { connected: false });
  assert.equal(fs.existsSync(config.youtubeAccountFile), false);
});
