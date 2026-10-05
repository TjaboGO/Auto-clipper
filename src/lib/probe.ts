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

/** Whether a media file has at least one audio stream. */
export async function probeHasAudio(filePath: string): Promise<boolean> {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-select_streams', 'a',
    '-show_entries', 'stream=index',
    '-of', 'csv=p=0',
    filePath,
  ]);
  return stdout.trim().length > 0;
}

export interface VideoDimensions {
  width: number;
  height: number;
}

/**
 * Pixel dimensions of a video's first video stream, as it is displayed.
 *
 * Phones usually store portrait video as landscape frames plus a rotation
 * flag. ffmpeg (and OpenCV) apply that rotation when decoding, so the frames
 * our filters see are portrait - the dimensions have to be swapped to match,
 * or a portrait video gets treated as landscape and cropped wrong.
 */
export async function probeDimensions(filePath: string): Promise<VideoDimensions> {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height:stream_tags=rotate:stream_side_data=rotation',
    '-of', 'json',
    filePath,
  ]);
  const parsed = JSON.parse(stdout);
  const stream = parsed.streams?.[0];
  if (!stream) throw new Error(`ffprobe found no video stream in ${filePath}`);

  const sideData: Array<{ rotation?: number }> = stream.side_data_list ?? [];
  const rotation =
    sideData.find((d) => typeof d.rotation === 'number')?.rotation ??
    parseFloat(stream.tags?.rotate ?? '0');
  const quarterTurn = Math.abs(Math.round(rotation / 90)) % 2 === 1;

  return quarterTurn
    ? { width: stream.height, height: stream.width }
    : { width: stream.width, height: stream.height };
}
