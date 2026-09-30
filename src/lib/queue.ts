import { config } from './config';

type Task = () => Promise<void>;

/**
 * Minimal in-process background queue. Video rendering is CPU/ffmpeg heavy,
 * so we cap concurrency (QUEUE_CONCURRENCY) instead of firing every job at
 * once. No external dependency (Redis/etc) - good enough for a single
 * self-hosted container; swap for BullMQ if you need multi-instance workers.
 */
export class Queue {
  private pending: Task[] = [];
  private active = 0;

  constructor(private concurrency: number) {}

  push(task: Task): void {
    this.pending.push(task);
    this.drain();
  }

  private drain(): void {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const task = this.pending.shift();
      if (!task) break;
      this.active++;
      task()
        .catch((err) => console.error('[queue] job failed unexpectedly:', err))
        .finally(() => {
          this.active--;
          this.drain();
        });
    }
  }
}

// Process-wide singleton (see jobStore.ts for why it lives on globalThis):
// a second queue instance would let two renders run at once.
const globalForQueue = globalThis as unknown as { __autoClipperQueue?: Queue };
export const renderQueue = (globalForQueue.__autoClipperQueue ??= new Queue(config.queueConcurrency));
