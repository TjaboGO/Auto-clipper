import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCookieFile, explainDownloadError, parseProgressLine } from './youtube';

const NOW = 1_800_000_000;
const cookie = (domain: string, name: string, expires = NOW + 3600) =>
  [domain, 'TRUE', '/', 'TRUE', String(expires), name, 'abc123'].join('\t');

test('a browser cookies.txt is accepted and tidied', () => {
  const raw = [
    '# Netscape HTTP Cookie File',
    '# This is a generated file!',
    cookie('.youtube.com', 'VISITOR_INFO1_LIVE'),
    `#HttpOnly_${cookie('.youtube.com', 'LOGIN_INFO')}`,
    cookie('.google.com', '__Secure-3PSID'),
    cookie('.example.com', 'other'),
    '',
  ].join('\r\n');
  const check = checkCookieFile(raw, NOW);
  assert.equal(check.total, 4);
  assert.equal(check.youtube, 3);
  assert.equal(check.signedIn, true);
  assert.equal(check.expired, false);
  assert.ok(check.text.startsWith('# Netscape HTTP Cookie File\n'));
  assert.ok(!check.text.includes('\r'));
  assert.ok(check.text.includes('#HttpOnly_.youtube.com\tTRUE'));
});

test('a header is added, and spaces instead of tabs are repaired', () => {
  const raw = '.youtube.com TRUE / TRUE 1900000000 PREF f6=40000000 hl=sv';
  const check = checkCookieFile(raw, NOW);
  assert.equal(check.signedIn, false);
  const lines = check.text.trim().split('\n');
  assert.equal(lines[0], '# Netscape HTTP Cookie File');
  assert.deepEqual(lines[1].split('\t'), ['.youtube.com', 'TRUE', '/', 'TRUE', '1900000000', 'PREF', 'f6=40000000 hl=sv']);
});

test('things that are not YouTube cookies are turned away with a reason', () => {
  assert.throws(() => checkCookieFile('[{"domain": ".youtube.com"}]', NOW), /JSON/);
  assert.throws(() => checkCookieFile('hej hej', NOW), /inga cookies/);
  assert.throws(() => checkCookieFile(cookie('.example.com', 'x'), NOW), /youtube\.com/);
  assert.equal(checkCookieFile(cookie('.youtube.com', 'SID', NOW - 10), NOW).expired, true);
  assert.equal(checkCookieFile(cookie('.youtube.com', 'SID', 0), NOW).expired, false); // session cookie
});

test('progress lines from yt-dlp', () => {
  assert.deepEqual(parseProgressLine('ac-progress  42.5% avc1.640028'), { percent: 42.5, part: 'video' });
  assert.deepEqual(parseProgressLine('ac-progress 100.0% none'), { percent: 100, part: 'audio' });
  assert.deepEqual(parseProgressLine('ac-progress   3.4% NA'), { percent: 3.4, part: 'file' });
  assert.equal(parseProgressLine('[download] Destination: x.mp4'), null);
});

test('download errors say what to do', () => {
  const bot = "ERROR: [youtube] abc: Sign in to confirm you’re not a bot. Use --cookies-from-browser";
  assert.match(explainDownloadError(bot, false), /Lägg till cookies/);
  assert.match(explainDownloadError(bot, true), /inte räcka/);
  assert.match(explainDownloadError('ERROR: [youtube] abc: Private video. Sign in', false), /privat/);
  assert.match(explainDownloadError('ERROR: [youtube] abc: Sign in to confirm your age', false), /åldersgräns/);
  assert.match(explainDownloadError('ERROR: [youtube] abc: Video unavailable', false), /finns inte/);
  assert.match(explainDownloadError('ERROR: [youtube] abc: This live event will begin in 3 hours', false), /Livesändningar/);
  assert.match(explainDownloadError('WARNING: The provided YouTube account cookies are no longer valid', true), /gått ut/);
  assert.equal(explainDownloadError('ERROR: something odd happened', false), 'Kunde inte ladda ner videon: something odd happened');
  assert.match(explainDownloadError('ERROR: [generic] Unable to download webpage: HTTP Error 403: Forbidden', false), /nekade/);
});
