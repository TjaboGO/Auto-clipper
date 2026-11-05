// "Mall från video": a video you like (a file, or a TikTok, YouTube or other
// link) becomes one of your templates. The video is shrunk, Gemini watches
// and listens to it and answers in our own settings (gemini.ts), and the
// answer is saved as a template with notes on what the app can't do yet.
// Runs in the background; the settings page asks how it's going.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { brandInfo, saveTemplate } from './brand';
import { config } from './config';
import { run } from './exec';
import { analyzeVideoStyle } from './gemini';
import { probeDuration, probeHasAudio } from './probe';
import { downloadFromUrl } from './youtube';
import { styleFromAnalysis, uniqueName } from './edit/videoStyle';
import type { StyleTemplate } from './edit/types';

/** Gemini only needs a taste of the style: the first few minutes. */
export const STYLE_MAX_SECONDS = 180;

export interface StyleJob {
  id: string;
  status: 'working' | 'done' | 'error';
  /** What it's doing right now. */
  step: string;
  error?: string;
  template?: StyleTemplate;
}

// Jobs on their way, per process (see jobStore.ts for why on globalThis).
const globalForStyles = globalThis as unknown as { __autoClipperStyleJobs?: Map<string, StyleJob> };
const jobs = (globalForStyles.__autoClipperStyleJobs ??= new Map());

export function styleJob(id: string): StyleJob | null {
  return jobs.get(id) ?? null;
}

function workDirFor(id: string): string {
  return path.join(/* turbopackIgnore: true */ config.workDir, `style-${id}`);
}

/** A folder for an uploaded video, before the job starts. */
export function newStyleUpload(): { id: string; dir: string } {
  const id = crypto.randomUUID();
  const dir = workDirFor(id);
  fs.mkdirSync(dir, { recursive: true });
  return { id, dir };
}

/** Start making a template from a video: an uploaded file (in newStyleUpload's folder) or a link. */
export function startStyleFromVideo(
  input: { id?: string; file?: string; url?: string; from?: string; name?: string },
): StyleJob {
  const id = input.id ?? crypto.randomUUID();
  const job: StyleJob = { id, status: 'working', step: input.url ? 'Hämtar videon ...' : 'Förbereder videon ...' };
  jobs.set(id, job);
  // Old finished jobs don't need to stay around.
  if (jobs.size > 50) {
    for (const [key, value] of jobs) if (value.status !== 'working') jobs.delete(key);
  }
  void make(job, input);
  return job;
}

async function make(job: StyleJob, input: { file?: string; url?: string; from?: string; name?: string }): Promise<void> {
  const dir = workDirFor(job.id);
  try {
    fs.mkdirSync(dir, { recursive: true });
    let source = input.file;
    let from = input.from || 'en video';
    if (input.url) {
      const downloaded = await downloadFromUrl(input.url, dir, { workDir: dir });
      source = downloaded.path;
      from = downloaded.title || input.url;
    }
    if (!source || !fs.existsSync(source)) throw new Error('Videon kom aldrig fram.');

    // A small copy: the first minutes, short side 720 px, with its sound.
    job.step = 'Förbereder videon ...';
    const small = path.join(/* turbopackIgnore: true */ dir, 'style.mp4');
    const sound = await probeHasAudio(source).catch(() => false);
    await run(
      'ffmpeg',
      [
        '-y', '-i', source, '-t', String(STYLE_MAX_SECONDS),
        '-vf', "scale='if(gt(iw,ih),-2,720)':'if(gt(iw,ih),720,-2)'",
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p',
        ...(sound ? ['-c:a', 'aac', '-b:a', '96k'] : ['-an']),
        '-movflags', '+faststart', small,
      ],
      {},
      10 * 60 * 1000,
    );
    const duration = await probeDuration(small);

    job.step = 'Gemini tittar och lyssnar ...';
    const analysis = await analyzeVideoStyle(small, duration);

    job.step = 'Sparar mallen ...';
    const made = styleFromAnalysis(analysis, from);
    const wanted = (input.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
    const taken = (brandInfo().templates ?? []).map((t) => t.name);
    // A name of yours replaces your template by that name; the AI's never does.
    const name = wanted || uniqueName(made.name, taken);
    job.template = saveTemplate(name, made.style, made.origin);
    job.status = 'done';
    job.step = 'Klar';
  } catch (err) {
    console.error(`[style] template from video ${job.id} failed:`, err);
    job.status = 'error';
    job.error = err instanceof Error ? err.message.split('\n')[0] : String(err);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
