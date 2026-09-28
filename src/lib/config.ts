import path from 'path';

function resolveStorageDir(): string {
  const dir = process.env.STORAGE_DIR || './storage';
  return path.isAbsolute(dir) ? dir : path.join(process.cwd(), dir);
}

const storageDir = resolveStorageDir();

export const config = {
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
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

  // Max upload size accepted by the /api/jobs route, in bytes.
  maxUploadBytes: 2 * 1024 * 1024 * 1024, // 2GB
};

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = raw ? parseInt(raw, 10) : NaN;
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
