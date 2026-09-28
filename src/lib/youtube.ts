import fs from 'fs';
import path from 'path';
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

/**
 * Download a YouTube (or any other yt-dlp-supported) URL into outDir as
 * source.<ext>. Requires the `yt-dlp` binary on PATH (installed in the
 * Docker image; see Dockerfile).
 */
export async function downloadFromUrl(url: string, outDir: string): Promise<string> {
  if (!isDownloadableUrl(url)) {
    throw new Error('Länken måste börja med http:// eller https://.');
  }
  fs.mkdirSync(outDir, { recursive: true });
  const outTemplate = path.join(outDir, 'source.%(ext)s');

  const { stdout } = await run('yt-dlp', [
    '-f',
    'bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/best[ext=mp4]/best',
    '--merge-output-format',
    'mp4',
    '--no-playlist',
    // Print the final file path (after merging) instead of guessing it.
    '--print',
    'after_move:filepath',
    '-o',
    outTemplate,
    // `--` so the URL can never be parsed as an option.
    '--',
    url,
  ]);

  const printed = stdout.trim().split('\n').pop()?.trim();
  if (printed && fs.existsSync(printed)) return printed;

  const match = fs
    .readdirSync(outDir)
    .find((f) => f.startsWith('source.') && !f.endsWith('.part') && !f.endsWith('.ytdl'));
  if (!match) {
    throw new Error('yt-dlp finished without producing an output file - the download likely failed.');
  }
  return path.join(outDir, match);
}
