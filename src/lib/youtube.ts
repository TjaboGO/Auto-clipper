import fs from 'fs';
import path from 'path';
import { run } from './exec';

/**
 * Download a YouTube (or any other yt-dlp-supported) URL into outDir as
 * source.mp4. Requires the `yt-dlp` binary on PATH (installed in the
 * Docker image; see Dockerfile).
 */
export async function downloadFromUrl(url: string, outDir: string): Promise<string> {
  fs.mkdirSync(outDir, { recursive: true });
  const outTemplate = path.join(outDir, 'source.%(ext)s');

  await run('yt-dlp', [
    '-f',
    'bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/best[ext=mp4]/best',
    '--merge-output-format',
    'mp4',
    '--no-playlist',
    '-o',
    outTemplate,
    url,
  ]);

  const match = fs.readdirSync(outDir).find((f) => f.startsWith('source.'));
  if (!match) {
    throw new Error('yt-dlp finished without producing an output file - the download likely failed.');
  }
  return path.join(outDir, match);
}
