import path from 'path';

function resolveStorageDir(): string {
  const dir = process.env.STORAGE_DIR || './storage';
  // Runtime data, not code: tell the bundler not to trace it into the build.
  return path.isAbsolute(dir) ? dir : path.join(/* turbopackIgnore: true */ process.cwd(), dir);
}

const storageDir = resolveStorageDir();

export const config = {
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
  // A model per step, if you want: listening to the audio, watching the
  // video, and picking the clips (where a stronger model pays off most).
  // Empty = GEMINI_MODEL.
  transcribeModel: process.env.GEMINI_TRANSCRIBE_MODEL || process.env.GEMINI_MODEL || 'gemini-3.8-flash',
  visionModel: process.env.GEMINI_VISION_MODEL || process.env.GEMINI_MODEL || 'gemini-3.8-flash',
  highlightModel: process.env.GEMINI_HIGHLIGHT_MODEL || process.env.GEMINI_MODEL || 'gemini-3.8-flash',
  // Picking the clips can go through OpenRouter instead, to use any model
  // it has. Only the transcript goes there;
  // the audio and video still go to Gemini.
  highlightProvider: (process.env.HIGHLIGHT_PROVIDER || '').toLowerCase() === 'openrouter' ? ('openrouter' as const) : ('gemini' as const),
  openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
  openrouterModel: process.env.OPENROUTER_MODEL || 'google/gemini-3.8-flash',
  openrouterBaseUrl: (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
  defaultClipCount: clampInt(process.env.DEFAULT_CLIP_COUNT, 6, 1, 15),
  queueConcurrency: clampInt(process.env.QUEUE_CONCURRENCY, 1, 1, 8),
  storageDir,
  uploadsDir: path.join(storageDir, 'uploads'),
  workDir: path.join(storageDir, 'work'),
  outputDir: path.join(storageDir, 'output'),
  // Source videos are kept after the job so clips can be edited and
  // rendered again, then deleted after SOURCE_RETENTION_DAYS without use
  // (0 = delete right after the job, which turns editing off).
  sourcesDir: path.join(storageDir, 'sources'),
  sourceRetentionDays: clampInt(process.env.SOURCE_RETENTION_DAYS, 7, 0, 365),
  // The editor's files per clip: words, framing, your edits, preview video.
  editorDir: path.join(/* turbopackIgnore: true */ storageDir, 'editor'),
  jobsFile: path.join(storageDir, 'jobs.json'),
  // Your brand kit: fonts you uploaded, your logo and "Min stil".
  brandDir: path.join(/* turbopackIgnore: true */ storageDir, 'brand'),
  // Cookies for yt-dlp (a Netscape cookies.txt), for videos YouTube only
  // lets signed-in users download. Saved from the settings page, or
  // YTDLP_COOKIES points at a file of your own (then the page can't change it).
  youtubeCookiesFile: process.env.YTDLP_COOKIES || path.join(storageDir, 'youtube-cookies.txt'),
  youtubeCookiesFromEnv: !!process.env.YTDLP_COOKIES,

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
