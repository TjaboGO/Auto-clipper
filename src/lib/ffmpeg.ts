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
 * A small copy of part of the video for Gemini to watch: one frame per
 * second (Gemini looks at one per second anyway), the short side 360 px,
 * and the sound in mono. An hour of video becomes well under 100 MB, so it
 * uploads quickly.
 */
export async function makeVisionCopy(
  videoPath: string,
  outPath: string,
  range: { start: number; duration: number },
): Promise<void> {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await run(
    'ffmpeg',
    [
      '-y',
      '-ss', String(range.start),
      '-t', String(range.duration),
      '-i', videoPath,
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-vf', "fps=1,scale='if(gte(iw,ih),-2,360)':'if(gte(iw,ih),360,-2)'",
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '30',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '32k',
      '-ac', '1',
      '-ar', '16000',
      '-movflags', '+faststart',
      outPath,
    ],
    {},
    30 * 60 * 1000,
  );
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
