import path from 'path';

function resolveStorageDir(): string {
  const dir = process.env.STORAGE_DIR || './storage';
  // Runtime data, not code: tell the bundler not to trace it into the build.
  return path.isAbsolute(dir) ? dir : path.join(/* turbopackIgnore: true */ process.cwd(), dir);
}

const storageDir = resolveStorageDir();

export const config = {
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
  defaultClipCount: clampInt(process.env.DEFAULT_CLIP_COUNT, 6, 1, 15),
  queueConcurrency: clampInt(process.env.QUEUE_CONCURRENCY, 1, 1, 8),
  storageDir,
  uploadsDir: path.join(storageDir, 'uploads'),
  workDir: path.join(storageDir, 'work'),
  outputDir: path.join(storageDir, 'output'),
  jobsFile: path.join(storageDir, 'jobs.json'),

  // Clip length bounds we ask Gemini to respect, in seconds.
  minClipSeconds: 15,
  maxClipSeconds: 90,

  // Long audio is transcribed in chunks of this many seconds. Keeps every
  // Gemini response far below the output token limit and keeps timestamps
  // accurate (they drift on very long audio).
  transcribeChunkSeconds: 600,

  // Max upload size accepted by the /api/jobs route, in bytes.
  maxUploadBytes: 2 * 1024 * 1024 * 1024, // 2GB

  // Exact word timing for captions: Whisper listens to each finished clip.
  // WORD_TIMING=off falls back to splitting Gemini's sentence times evenly.
  wordTiming: (process.env.WORD_TIMING || 'on').toLowerCase() !== 'off',
  whisperModel: process.env.WHISPER_MODEL || 'small',
  // Downloaded Whisper models live next to the job data, so they survive
  // container rebuilds when storage is a volume.
  modelsDir: path.join(storageDir, 'models'),

  // Caption font (bundled, see assets/fonts) and the helper script for the
  // face-tracked crop. Both resolve against the app root, which is also the
  // working directory of the standalone server in the Docker image.
  fontsDir: path.join(process.cwd(), 'assets', 'fonts'),
  smartCropScript: path.join(process.cwd(), 'scripts', 'smart_crop.py'),
  // YuNet face detector (OpenCV Zoo, MIT license) used by smart_crop.py.
  faceModel: path.join(process.cwd(), 'assets', 'models', 'face_detection_yunet_2023mar.onnx'),
  wordTimingScript: path.join(process.cwd(), 'scripts', 'word_timing.py'),
};

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = raw ? parseInt(raw, 10) : NaN;
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
