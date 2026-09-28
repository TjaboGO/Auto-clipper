import fs from 'fs';
import { config } from './config';
import path from 'path';
import { ensureBaseDirs } from './paths';
import type { Job, JobProgressStep } from './types';

ensureBaseDirs();

const FINISHED: Job['status'][] = ['done', 'error'];

/**
 * In-memory job registry, persisted to storage/jobs.json on every write so
 * job history/status survives a restart. This is intentionally simple (no
 * database) - fine for a single-container, single-user deployment. If you
 * outgrow that, swap this module for a real DB and keep the same API.
 */
class JobStore {
  private jobs = new Map<string, Job>();
  private loaded = false;

  private load() {
    if (this.loaded) return;
    this.loaded = true;
    let arr: Job[];
    try {
      arr = JSON.parse(fs.readFileSync(config.jobsFile, 'utf-8')) as Job[];
    } catch {
      // No jobs.json yet (first run) - nothing to load.
      return;
    }

    // The queue lives in memory, so anything that was still running when the
    // server stopped (e.g. a redeploy) will never finish. Say so instead of
    // leaving the job page spinning forever, and drop its files (clips that
    // were already rendered stay). A clip that was being rendered again from
    // the editor gets the same treatment.
    const now = new Date().toISOString();
    let interrupted = false;
    for (const job of arr) {
      if (!FINISHED.includes(job.status)) {
        const message = 'Servern startades om medan jobbet kördes. Starta ett nytt jobb.';
        job.status = 'error';
        job.error = message;
        job.updatedAt = now;
        job.progress.push({ step: 'error', message, at: now });
        for (const dir of [config.workDir, config.sourcesDir, config.editorDir]) {
          fs.rmSync(path.join(dir, job.id), { recursive: true, force: true });
        }
        job.sourceVideoPath = undefined;
        interrupted = true;
      }
      for (const clip of job.clips ?? []) {
        if (clip.renderState && clip.renderState.status !== 'error') {
          fs.rmSync(path.join(config.workDir, `${job.id}-edit-${clip.id}`), { recursive: true, force: true });
          clip.renderState = {
            status: 'error',
            error: 'Servern startades om under renderingen. Försök igen.',
            at: now,
          };
          interrupted = true;
        }
      }
      this.jobs.set(job.id, job);
    }
    if (interrupted) this.persist();
  }

  private persist() {
    try {
      const arr = Array.from(this.jobs.values());
      // Write to a temp file and rename over the old one, so a crash
      // mid-write can't leave a half-written (unreadable) jobs.json behind.
      const tmp = `${config.jobsFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(arr, null, 2));
      fs.renameSync(tmp, config.jobsFile);
    } catch (err) {
      console.error('[jobStore] failed to persist jobs.json:', err);
    }
  }

  create(job: Job): Job {
    this.load();
    this.jobs.set(job.id, job);
    this.persist();
    return job;
  }

  get(id: string): Job | undefined {
    this.load();
    return this.jobs.get(id);
  }

  update(id: string, patch: Partial<Job>): Job | undefined {
    this.load();
    const existing = this.jobs.get(id);
    if (!existing) return undefined;
    const updated: Job = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    this.jobs.set(id, updated);
    this.persist();
    return updated;
  }

  appendProgress(id: string, step: JobProgressStep): void {
    this.load();
    const existing = this.jobs.get(id);
    if (!existing) return;
    existing.progress.push(step);
    existing.updatedAt = new Date().toISOString();
    this.persist();
  }

  delete(id: string): boolean {
    this.load();
    const existed = this.jobs.delete(id);
    if (existed) this.persist();
    return existed;
  }

  list(): Job[] {
    this.load();
    return Array.from(this.jobs.values()).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }
}

// Process-wide singleton. Kept on globalThis so every route bundle (and dev
// mode hot reloads) share the same instance instead of each getting its own
// copy of the job list.
const globalForJobs = globalThis as unknown as { __autoClipperJobStore?: JobStore };
export const jobStore = (globalForJobs.__autoClipperJobStore ??= new JobStore());
