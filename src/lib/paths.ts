import fs from 'fs';
import path from 'path';
import { config } from './config';

export function ensureBaseDirs() {
  for (const dir of [
    config.storageDir,
    config.uploadsDir,
    config.workDir,
    config.outputDir,
    config.sourcesDir,
    config.editorDir,
  ]) {
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

/** Where a job's source video is kept (see SOURCE_RETENTION_DAYS). */
export function jobSourceDir(jobId: string): string {
  const dir = path.join(config.sourcesDir, jobId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** The editor's files for a job's clips (never served directly). */
export function jobEditorDir(jobId: string): string {
  const dir = path.join(config.editorDir, jobId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Every directory a job owns, for deleting it. */
export function jobDirs(jobId: string): string[] {
  return [config.workDir, config.outputDir, config.sourcesDir, config.editorDir].map((dir) =>
    path.join(dir, jobId),
  );
}

/** Prevent path traversal when a jobId/filename come from a URL param. */
export function isSafeSegment(segment: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(segment);
}
