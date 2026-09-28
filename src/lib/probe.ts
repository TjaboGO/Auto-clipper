import { run } from './exec';

/** Duration of a media file in seconds. */
export async function probeDuration(filePath: string): Promise<number> {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ]);
  const seconds = parseFloat(stdout.trim());
  if (Number.isNaN(seconds)) {
    throw new Error(`ffprobe returned a non-numeric duration for ${filePath}: "${stdout}"`);
  }
  return seconds;
}

export interface VideoDimensions {
  width: number;
  height: number;
}

/** Pixel dimensions of a video's first video stream. */
export async function probeDimensions(filePath: string): Promise<VideoDimensions> {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'json',
    filePath,
  ]);
  const parsed = JSON.parse(stdout);
  const stream = parsed.streams?.[0];
  if (!stream) throw new Error(`ffprobe found no video stream in ${filePath}`);
  return { width: stream.width, height: stream.height };
}
