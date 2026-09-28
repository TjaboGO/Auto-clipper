import fs from 'fs';
import path from 'path';
import { config } from './config';
import { run } from './exec';
import { probeDimensions } from './probe';
import { computeCropKeyframes, keyframesToCropXExpr } from './smartCrop';
import { escapeFfmpegFilterPath } from './captions';

// Standard short-form vertical output resolution (TikTok/Reels/Shorts).
const OUTPUT_WIDTH = 1080;
const OUTPUT_HEIGHT = 1920;

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
}

/**
 * Render one final vertical clip in a single ffmpeg pass:
 *  1. trims [start,end] out of the source
 *  2. reframes to 9:16 - face-tracked smart crop if the source is
 *     wider than 9:16, or scale+letterbox if it's already that narrow
 *  3. burns in the word-highlighted .ass captions
 */
export async function renderClip(opts: RenderClipOptions): Promise<void> {
  const { sourcePath, start, end, assPath, outPath } = opts;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const dims = await probeDimensions(sourcePath);
  const { width, height } = dims;
  const isLandscape = width / height > OUTPUT_WIDTH / OUTPUT_HEIGHT;

  let visualFilter: string;
  if (isLandscape) {
    const cropWidth = Math.max(2, Math.floor((height * OUTPUT_WIDTH) / OUTPUT_HEIGHT / 2) * 2);
    const keyframes = await computeCropKeyframes(sourcePath, start, end, dims);
    const xExpr = keyframesToCropXExpr(keyframes, cropWidth, width);
    visualFilter = `crop=w=${cropWidth}:h=${height}:x='${xExpr}':y=0,scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}`;
  } else {
    visualFilter =
      `scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease,` +
      `pad=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black`;
  }

  const assFilter =
    `ass=filename='${escapeFfmpegFilterPath(assPath)}'` +
    `:fontsdir='${escapeFfmpegFilterPath(config.fontsDir)}'`;
  const filterChain = `${visualFilter},setsar=1,${assFilter}`;

  await run('ffmpeg', [
    '-y',
    '-ss', String(start),
    '-t', String(Math.max(0.2, end - start)),
    '-i', sourcePath,
    '-vf', filterChain,
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
