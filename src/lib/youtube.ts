import fs from 'fs';
import path from 'path';
import { config } from './config';
import { run } from './exec';

/** Only plain http(s) links - anything else could be read as a yt-dlp option or a local path. */
export function isDownloadableUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Cookies: YouTube often stops downloads from servers ("Sign in to confirm
// you're not a bot") and always for age-restricted videos. yt-dlp gets past
// that with the cookies of a signed-in browser, as a Netscape cookies.txt.
// ---------------------------------------------------------------------------

const COOKIE_HEADER = '# Netscape HTTP Cookie File';
// Cookies that are only there when you're signed in to Google/YouTube.
const SIGNED_IN = ['SID', '__Secure-1PSID', '__Secure-3PSID', 'LOGIN_INFO', 'SAPISID'];

export interface CookieCheck {
  /** The file as yt-dlp wants it (header first, tabs, \n line endings). */
  text: string;
  total: number;
  /** Cookies for youtube.com or google.com. */
  youtube: number;
  signedIn: boolean;
  /** Every YouTube cookie has expired. */
  expired: boolean;
}

/**
 * Check and tidy a pasted or uploaded cookies.txt. Throws with a message for
 * the user if it isn't one. Lines copied from a browser sometimes have
 * spaces instead of tabs; those are repaired.
 */
export function checkCookieFile(raw: string, now = Date.now() / 1000): CookieCheck {
  const trimmed = raw.replace(/^﻿/, '').trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    throw new Error('Det här är cookies i JSON-format. yt-dlp vill ha en cookies.txt (Netscape-format).');
  }
  const lines: string[] = [COOKIE_HEADER];
  let total = 0;
  let youtube = 0;
  let live = 0;
  let signedIn = false;
  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const httpOnly = line.startsWith('#HttpOnly_');
    if (!line || (line.startsWith('#') && !httpOnly)) continue;
    let fields = line.split('\t');
    if (fields.length !== 7) {
      const words = line.trim().split(/\s+/);
      if (words.length < 7) continue;
      fields = [...words.slice(0, 6), words.slice(6).join(' ')];
    }
    const [domain, , , , expires, name] = fields;
    if (!/^(#HttpOnly_)?\.?[a-z0-9.-]+$/i.test(domain) || !/^\d+(\.\d+)?$/.test(expires || '0')) continue;
    total++;
    const host = domain.replace(/^#HttpOnly_/, '').replace(/^\./, '').toLowerCase();
    if (host.endsWith('youtube.com') || host.endsWith('google.com')) {
      youtube++;
      const at = Number(expires || 0);
      if (at === 0 || at > now) live++;
      if (SIGNED_IN.includes(name)) signedIn = true;
    }
    lines.push(fields.join('\t'));
  }
  if (total === 0) {
    throw new Error('Hittade inga cookies. Exportera en cookies.txt från webbläsaren där du är inloggad på YouTube.');
  }
  if (youtube === 0) {
    throw new Error('Filen har inga cookies för youtube.com. Exportera dem medan du är inne på YouTube.');
  }
  return { text: lines.join('\n') + '\n', total, youtube, signedIn, expired: live === 0 };
}

export interface CookieStatus {
  present: boolean;
  /** Set with YTDLP_COOKIES: the settings page can't change it. */
  fromEnv: boolean;
  updatedAt?: string;
  youtube?: number;
  signedIn?: boolean;
  expired?: boolean;
}

/** Whether there are cookies, and a little about them - never the cookies themselves. */
export function cookieStatus(): CookieStatus {
  const file = config.youtubeCookiesFile;
  const status: CookieStatus = { present: false, fromEnv: config.youtubeCookiesFromEnv };
  try {
    const stat = fs.statSync(file);
    const check = checkCookieFile(fs.readFileSync(file, 'utf8'));
    return {
      ...status,
      present: true,
      updatedAt: stat.mtime.toISOString(),
      youtube: check.youtube,
      signedIn: check.signedIn,
      expired: check.expired,
    };
  } catch {
    return status;
  }
}

export function saveCookies(raw: string): CookieStatus {
  if (config.youtubeCookiesFromEnv) throw new Error('Cookies kommer från YTDLP_COOKIES och ändras där.');
  const check = checkCookieFile(raw);
  fs.mkdirSync(path.dirname(config.youtubeCookiesFile), { recursive: true });
  fs.writeFileSync(config.youtubeCookiesFile, check.text, { mode: 0o600 });
  return cookieStatus();
}

export function deleteCookies(): void {
  if (config.youtubeCookiesFromEnv) throw new Error('Cookies kommer från YTDLP_COOKIES och ändras där.');
  fs.rmSync(config.youtubeCookiesFile, { force: true });
}

// ---------------------------------------------------------------------------
// Downloading
// ---------------------------------------------------------------------------

export interface DownloadProgress {
  percent: number;
  /** Video and sound come separately from YouTube and are joined after. */
  part: 'video' | 'audio' | 'file';
}

const PROGRESS_MARK = 'ac-progress';

/** A progress line from yt-dlp (see the --progress-template below), or null. */
export function parseProgressLine(line: string): DownloadProgress | null {
  const match = new RegExp(`^${PROGRESS_MARK}\\s+([\\d.]+)%\\s+(\\S+)`).exec(line.trim());
  if (!match) return null;
  const vcodec = match[2];
  return {
    percent: Math.min(100, Number(match[1])),
    part: vcodec === 'none' ? 'audio' : vcodec === 'NA' ? 'file' : 'video',
  };
}

/** What went wrong, in words that say what to do (yt-dlp's output in). */
export function explainDownloadError(output: string, hadCookies: boolean): string {
  const has = (re: RegExp) => re.test(output);
  const cookieHint = hadCookies
    ? 'Dina YouTube-cookies verkar inte räcka. Exportera nya under Inställningar.'
    : 'Lägg till cookies från ett inloggat YouTube-konto under Inställningar.';
  if (has(/cookies are no longer valid|cookies.*(expired|invalid)/i)) {
    return 'Dina YouTube-cookies har gått ut. Exportera nya och spara dem under Inställningar.';
  }
  if (has(/confirm you.?re not a bot|confirm you are not a bot/i)) {
    return `YouTube stoppade nedladdningen och vill att du loggar in. ${cookieHint}`;
  }
  if (has(/confirm your age|age.?restricted|inappropriate for some users/i)) {
    return `Videon har åldersgräns. ${cookieHint}`;
  }
  if (has(/private video/i)) return 'Videon är privat. Bara ägaren kan se den.';
  if (has(/members.?only|join this channel/i)) return 'Videon är bara för kanalens medlemmar.';
  if (has(/live event will begin|premieres in|this live event|is not currently live|is live/i)) {
    return 'Livesändningar och premiärer går inte att klippa förrän de är slut.';
  }
  if (has(/not (made )?available in your country|geo.?restrict/i)) {
    return 'Videon är inte tillgänglig i landet där servern står.';
  }
  if (has(/HTTP Error 429|too many requests/i)) {
    return `YouTube tycker att servern hämtar för mycket just nu (429). Vänta en stund. ${cookieHint}`;
  }
  if (has(/HTTP Error 403/i)) return `Sidan nekade nedladdningen (403). ${cookieHint}`;
  if (has(/video unavailable|has been removed|does not exist|HTTP Error 404/i)) {
    return 'Videon finns inte eller har tagits bort.';
  }
  if (has(/unsupported url/i)) return 'Länken stöds inte. Klistra in en länk direkt till en video.';
  if (has(/unable to download (webpage|api page)|failed to establish|name or service not known|timed out|connection (refused|reset)/i)) {
    return 'Servern kunde inte nå sidan. Kolla länken och serverns internetanslutning.';
  }
  const lastError = output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('ERROR:'))
    .pop();
  return `Kunde inte ladda ner videon${lastError ? `: ${lastError.replace(/^ERROR:\s*/, '').slice(0, 300)}` : '.'}`;
}

export interface DownloadResult {
  path: string;
  title?: string;
  uploader?: string;
  duration?: number;
}

/**
 * Download a YouTube (or any other yt-dlp-supported) URL into outDir as
 * source.<ext>, reporting progress. Uses the saved cookies if there are any
 * (a copy in workDir, since yt-dlp writes back to the file). Requires the
 * `yt-dlp` binary on PATH (installed in the Docker image; see Dockerfile).
 */
export async function downloadFromUrl(
  url: string,
  outDir: string,
  opts: { workDir: string; onProgress?: (progress: DownloadProgress) => void },
): Promise<DownloadResult> {
  if (!isDownloadableUrl(url)) {
    throw new Error('Länken måste börja med http:// eller https://.');
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(opts.workDir, { recursive: true });
  const outTemplate = path.join(outDir, 'source.%(ext)s');

  let cookieArgs: string[] = [];
  const cookieCopy = path.join(opts.workDir, 'cookies.txt');
  if (fs.existsSync(config.youtubeCookiesFile)) {
    fs.copyFileSync(config.youtubeCookiesFile, cookieCopy);
    fs.chmodSync(cookieCopy, 0o600);
    cookieArgs = ['--cookies', cookieCopy];
  }

  let printed: DownloadResult | undefined;
  try {
    const { stdout } = await run(
      'yt-dlp',
      [
        '-f',
        'bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/best[ext=mp4]/best',
        '--merge-output-format',
        'mp4',
        '--no-playlist',
        '--socket-timeout',
        '30',
        ...cookieArgs,
        // Where the file ended up (after merging) and what the video is called.
        '--print',
        'after_move:%(.{filepath,title,uploader,duration})j',
        // --print makes yt-dlp quiet; bring back the progress, one line each.
        '--progress',
        '--newline',
        '--progress-template',
        `download:${PROGRESS_MARK} %(progress._percent_str)s %(info.vcodec)s`,
        '-o',
        outTemplate,
        // `--` so the URL can never be parsed as an option.
        '--',
        url,
      ],
      {},
      4 * 60 * 60 * 1000,
      (line) => {
        const progress = parseProgressLine(line);
        if (progress) opts.onProgress?.(progress);
      },
    );
    const json = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('{'))
      .pop();
    if (json) {
      const info = JSON.parse(json) as { filepath?: string; title?: string; uploader?: string; duration?: number };
      if (info.filepath && fs.existsSync(info.filepath)) {
        printed = {
          path: info.filepath,
          title: typeof info.title === 'string' ? info.title.slice(0, 200) : undefined,
          uploader: typeof info.uploader === 'string' ? info.uploader.slice(0, 100) : undefined,
          duration: typeof info.duration === 'number' ? info.duration : undefined,
        };
      }
    }
  } catch (err) {
    const output = err instanceof Error ? err.message : String(err);
    console.warn('[youtube] yt-dlp failed:', output.slice(-1500));
    throw new Error(explainDownloadError(output, cookieArgs.length > 0));
  } finally {
    fs.rmSync(cookieCopy, { force: true });
  }
  if (printed) return printed;

  const match = fs
    .readdirSync(outDir)
    .find((f) => f.startsWith('source.') && !f.endsWith('.part') && !f.endsWith('.ytdl'));
  if (!match) {
    throw new Error('yt-dlp blev klar utan att spara någon fil. Nedladdningen misslyckades troligen.');
  }
  return { path: path.join(outDir, match) };
}
