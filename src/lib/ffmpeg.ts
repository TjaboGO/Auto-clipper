import fs from 'fs';
import path from 'path';
import { config } from './config';
import { run } from './exec';
import { framingFilterArgs, type Framing } from './smartCrop';
import { escapeFfmpegFilterPath } from './captions';

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

export interface RenderClipOptions {
  sourcePath: string;
  start: number;
  end: number;
  assPath: string;
  outPath: string;
  /** How to frame the clip in 9:16 (see planFraming). */
  framing: Framing;
}

/**
 * Render one final vertical clip in a single ffmpeg pass:
 *  1. trims [start,end] out of the source
 *  2. reframes to 9:16 as planned - following whoever talks, a split
 *     screen of two people, or scale+letterbox for an already narrow source
 *  3. burns in the word-highlighted .ass captions
 */
export async function renderClip(opts: RenderClipOptions): Promise<void> {
  const { sourcePath, start, end, assPath, outPath, framing } = opts;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const captionsFilter =
    `ass=filename='${escapeFfmpegFilterPath(assPath)}'` +
    `:fontsdir='${escapeFfmpegFilterPath(config.fontsDir)}'`;

  await run('ffmpeg', [
    '-y',
    '-ss', String(start),
    '-t', String(Math.max(0.2, end - start)),
    '-i', sourcePath,
    ...framingFilterArgs(framing, captionsFilter),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '21',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    outPath,
  ]);
}

/** Grab a single JPEG frame from a rendered clip, for gallery thumbnails. */
export async function generateThumbnail(clipPath: string, outPath: string): Promise<void> {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await run('ffmpeg', [
    '-y',
    '-ss', '0.3',
    '-i', clipPath,
    '-frames:v', '1',
    '-vf', 'scale=540:960',
    outPath,
  ]);
}
