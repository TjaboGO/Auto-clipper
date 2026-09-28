import fs from 'fs';
import path from 'path';
import { config } from './config';

export function ensureBaseDirs() {
  for (const dir of [config.storageDir, config.uploadsDir, config.workDir, config.outputDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Scratch dir for a job's intermediate files (audio, subtitles, crop data). */
export function jobWorkDir(jobId: string): string {
  const dir = path.join(config.workDir, jobId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Where a job's final rendered clips are written; served by /api/clips. */
export function jobOutputDir(jobId: string): string {
  const dir = path.join(config.outputDir, jobId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Prevent path traversal when a jobId/filename come from a URL param. */
export function isSafeSegment(segment: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(segment);
}
