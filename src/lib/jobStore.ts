import fs from 'fs';
import { config } from './config';
import { ensureBaseDirs } from './paths';
import type { Job, JobProgressStep } from './types';

ensureBaseDirs();

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
    try {
      const raw = fs.readFileSync(config.jobsFile, 'utf-8');
      const arr = JSON.parse(raw) as Job[];
      for (const job of arr) this.jobs.set(job.id, job);
    } catch {
      // No jobs.json yet (first run) - nothing to load.
    }
  }

  private persist() {
    try {
      const arr = Array.from(this.jobs.values());
      fs.writeFileSync(config.jobsFile, JSON.stringify(arr, null, 2));
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

  list(): Job[] {
    this.load();
    return Array.from(this.jobs.values()).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }
}

// Module-level singleton: survives across requests within one Node process.
export const jobStore = new JobStore();
