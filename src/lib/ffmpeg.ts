import fs from 'fs';
import path from 'path';
import { run } from './exec';

/**
 * Extract a 16 kHz mono audio track from a video: a small mp3 for uploading
 * to Gemini, or plain PCM when `outPath` ends in .wav (for word timing - mp3
 * adds encoder padding at the start, which would shift every timestamp).
 * Pass `start`/`duration` (seconds) to extract only that part.
 */
export async function extractAudio(
  videoPath: string,
  outPath: string,
  range?: { start: number; duration: number },
): Promise<void> {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const seek = range ? ['-ss', String(range.start), '-t', String(range.duration)] : [];
  const codec = outPath.endsWith('.wav') ? ['-c:a', 'pcm_s16le'] : ['-b:a', '64k'];
  await run('ffmpeg', [
    '-y',
    ...seek,
    '-i', videoPath,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    ...codec,
    outPath,
  ]);
}

/**
 * Grab a single JPEG frame from a rendered clip, for gallery thumbnails.
 * Half the clip's size, whatever its format.
 */
export async function generateThumbnail(clipPath: string, outPath: string): Promise<void> {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await run('ffmpeg', [
    '-y',
    '-ss', '0.3',
    '-i', clipPath,
    '-frames:v', '1',
    '-vf', 'scale=trunc(iw/4)*2:trunc(ih/4)*2',
    '-update', '1',
    outPath,
  ]);
}
