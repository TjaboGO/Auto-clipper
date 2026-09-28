import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { config } from './config';
import { run } from './exec';
import { generateThumbnail } from './ffmpeg';
import { jobStore } from './jobStore';
import { jobDirs, jobEditorDir, jobOutputDir } from './paths';
import { Queue, renderQueue } from './queue';
import { renderClipEdit } from './render';
import { analyzeFraming } from './smartCrop';
import { clipWords, endAfterWord, startBeforeWord } from './edit/timeline';
import { needsFramingAnalysis } from './editorWords';
import { timeWords } from './wordTiming';
import type { ClipEdit, ClipEditorData, TimeRange } from './edit/types';
import type { Job, RenderedClip } from './types';

// ---------------------------------------------------------------------------
// Files per clip, in storage/editor/<job>/

function editorFile(jobId: string, clipId: string, suffix: string): string {
  // Runtime data, not code: tell the bundler not to trace it into the build.
  return path.join(/* turbopackIgnore: true */ config.editorDir, jobId, `${clipId}.${suffix}`);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

export function readEditorData(jobId: string, clipId: string): ClipEditorData | null {
  return readJson<ClipEditorData>(editorFile(jobId, clipId, 'data.json'));
}

export function writeEditorData(jobId: string, clipId: string, data: ClipEditorData): void {
  jobEditorDir(jobId);
  writeJson(editorFile(jobId, clipId, 'data.json'), data);
}

export function readClipEdit(jobId: string, clipId: string): ClipEdit | null {
  return readJson<ClipEdit>(editorFile(jobId, clipId, 'edit.json'));
}

export function writeClipEdit(jobId: string, clipId: string, edit: ClipEdit): void {
  jobEditorDir(jobId);
  writeJson(editorFile(jobId, clipId, 'edit.json'), edit);
}

/**
 * The preview video: H.264 in MP4 plays everywhere that matters; WebM (VP9)
 * is made instead for browsers without H.264 (some Chromium builds).
 */
export type PreviewFormat = 'mp4' | 'webm';

export function proxyFile(jobId: string, clipId: string, format: PreviewFormat = 'mp4'): string {
  return editorFile(jobId, clipId, `proxy.${format}`);
}

function peaksFile(jobId: string, clipId: string): string {
  return editorFile(jobId, clipId, 'peaks.json');
}

/** Whether the job's source video is still around (needed to render again). */
export function sourceAvailable(job: Job): boolean {
  return !!job.sourceVideoPath && fs.existsSync(job.sourceVideoPath);
}

/** Whether a clip can be opened in the editor and rendered again. */
export function clipEditable(job: Job, clipId: string): boolean {
  return (
    job.status === 'done' &&
    sourceAvailable(job) &&
    fs.existsSync(editorFile(job.id, clipId, 'data.json')) &&
    fs.existsSync(editorFile(job.id, clipId, 'edit.json'))
  );
}

// ---------------------------------------------------------------------------
// Preview video and waveform for the editor

export interface PreviewStatus {
  status: 'ready' | 'pending' | 'error' | 'unavailable';
  error?: string;
}

interface PreviewState {
  pending: Set<string>;
  errors: Map<string, string>;
  queue: Queue;
}

// On globalThis for the same reason as the job store: one per process.
const globalForPreview = globalThis as unknown as { __autoClipperPreview?: PreviewState };
const preview = (globalForPreview.__autoClipperPreview ??= {
  pending: new Set(),
  errors: new Map(),
  queue: new Queue(1),
});

function even(n: number): number {
  return Math.max(2, Math.floor(n / 2) * 2);
}

/** Loudness peaks of the window's audio, 40 per second, 0..100. */
function computePeaks(sourcePath: string, window: TimeRange): Promise<{ rate: number; values: number[] }> {
  const rate = 40;
  const sampleRate = 8000;
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-v', 'error',
      '-ss', String(window.start),
      '-t', String(window.end - window.start),
      '-i', sourcePath,
      '-map', '0:a:0',
      '-ac', '1',
      '-ar', String(sampleRate),
      '-f', 's16le',
      'pipe:1',
    ]);
    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg could not read the audio: ${stderr.slice(-300)}`));
        return;
      }
      const pcm = Buffer.concat(chunks);
      const hop = sampleRate / rate;
      const count = Math.floor(pcm.length / 2 / hop);
      const raw: number[] = [];
      let loudest = 1;
      for (let i = 0; i < count; i++) {
        let peak = 0;
        for (let k = 0; k < hop; k++) peak = Math.max(peak, Math.abs(pcm.readInt16LE((i * hop + k) * 2)));
        raw.push(peak);
        loudest = Math.max(loudest, peak);
      }
      // Square root so quiet speech still shows next to loud parts.
      resolve({ rate, values: raw.map((v) => Math.round(100 * Math.sqrt(v / loudest))) });
    });
  });
}

async function generatePreview(job: Job, clipId: string, data: ClipEditorData, format: PreviewFormat): Promise<void> {
  const sourcePath = job.sourceVideoPath as string;
  const { width, height } = data.source;
  // A small, easy to seek copy of the window: long side 960 px and a
  // keyframe every 12 frames.
  const w = width >= height ? even(Math.min(960, width)) : even((width * Math.min(960, height)) / height);
  const h = width >= height ? even((height * w) / width) : even(Math.min(960, height));
  const out = proxyFile(job.id, clipId, format);
  const tmp = `${out}.tmp.${format}`;
  const codecs =
    format === 'webm'
      ? ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-b:v', '0', '-crf', '40',
         '-c:a', 'libopus', '-b:a', '96k']
      : ['-c:v', 'libx264', '-preset', 'superfast', '-crf', '30', '-sc_threshold', '0',
         '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart'];
  jobEditorDir(job.id);
  await run(
    'ffmpeg',
    [
      '-y',
      '-ss', String(data.window.start),
      '-t', String(data.window.end - data.window.start),
      '-i', sourcePath,
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-vf', `scale=${w}:${h}`,
      '-g', '12',
      '-keyint_min', '12',
      '-pix_fmt', 'yuv420p',
      '-ac', '2',
      ...codecs,
      tmp,
    ],
    {},
    15 * 60 * 1000,
  );
  if (!fs.existsSync(peaksFile(job.id, clipId))) {
    const peaks = data.source.hasAudio ? await computePeaks(sourcePath, data.window) : { rate: 40, values: [] };
    writeJson(peaksFile(job.id, clipId), peaks);
  }
  fs.renameSync(tmp, out);
}

/**
 * The preview video's state; starts making it if there isn't one. The
 * editor polls this while it's pending (takes a few seconds per clip).
 */
export function ensurePreview(
  job: Job,
  clipId: string,
  data: ClipEditorData,
  opts: { retry?: boolean; format?: PreviewFormat } = {},
): PreviewStatus {
  const format = opts.format ?? 'mp4';
  const retry = opts.retry ?? false;
  const key = `${job.id}/${clipId}/${format}`;
  if (fs.existsSync(proxyFile(job.id, clipId, format)) && fs.existsSync(peaksFile(job.id, clipId))) {
    return { status: 'ready' };
  }
  if (!sourceAvailable(job)) return { status: 'unavailable' };
  if (preview.pending.has(key)) return { status: 'pending' };
  const error = preview.errors.get(key);
  if (error && !retry) return { status: 'error', error };

  preview.errors.delete(key);
  preview.pending.add(key);
  preview.queue.push(async () => {
    try {
      await generatePreview(job, clipId, data, format);
    } catch (err) {
      console.error(`[editor] preview for ${key} failed:`, err);
      preview.errors.set(key, 'Kunde inte göra förhandsvisningen.');
    } finally {
      preview.pending.delete(key);
    }
  });
  return { status: 'pending' };
}

export function readPeaks(jobId: string, clipId: string): { rate: number; values: number[] } | null {
  return readJson(peaksFile(jobId, clipId));
}

// ---------------------------------------------------------------------------
// Rendering an edited clip again

function updateClip(jobId: string, clipId: string, patch: Partial<RenderedClip>): RenderedClip | undefined {
  const job = jobStore.get(jobId);
  if (!job?.clips) return undefined;
  let updated: RenderedClip | undefined;
  const clips = job.clips.map((c) => {
    if (c.id !== clipId) return c;
    updated = { ...c, ...patch };
    return updated;
  });
  jobStore.update(jobId, { clips });
  return updated;
}

/**
 * Words in the clip that Whisper never listened to (the clip was stretched
 * into the context around it) get exact times now. If a word then turns out
 * to reach past an edge, the edge moves out so it isn't cut off.
 */
async function refineWordTiming(job: Job, data: ClipEditorData, edit: ClipEdit, workDir: string): Promise<void> {
  const inClip = clipWords(data.words, edit);
  if (!config.wordTiming || inClip.length === 0 || inClip.every((w) => w.exact)) return;

  // Whole sentences, so Whisper and the alignment have context.
  const segs = new Set(inClip.map((w) => w.seg));
  const sentences = data.words.filter((w) => segs.has(w.seg));
  const range = {
    start: Math.max(data.window.start, Math.min(edit.start, sentences[0].start) - 0.5),
    end: Math.min(data.window.end, Math.max(edit.end, sentences[sentences.length - 1].end) + 0.5),
  };
  const timed = await timeWords({
    sourcePath: job.sourceVideoPath as string,
    durationSec: data.source.duration,
    range,
    words: sentences.map((w) => ({ text: w.text, start: w.start, end: w.end, seg: w.seg })),
    workDir,
  });
  if (!timed) return;

  const byId = new Map(sentences.map((w, i) => [w.id, timed[i]]));
  const firstId = inClip[0].id;
  const lastId = inClip[inClip.length - 1].id;
  data.words = data.words.map((w) => {
    const t = byId.get(w.id);
    return t ? { ...w, start: t.start, end: t.end, exact: true } : w;
  });
  const first = data.words.findIndex((w) => w.id === firstId);
  const last = data.words.findIndex((w) => w.id === lastId);
  if (first >= 0 && data.words[first].start < edit.start + 0.02) {
    edit.start = Math.min(edit.start, startBeforeWord(data.words, first, data.window));
  }
  if (last >= 0 && data.words[last].end > edit.end - 0.02) {
    edit.end = Math.max(edit.end, endAfterWord(data.words, last, data.window));
  }
}

/** The name a clip's files share, e.g. "clip_3" for clip_3.mp4 or clip_3_v2.mp4. */
function clipBaseName(filename: string): string {
  return filename.replace(/(_v\d+)?\.mp4$/, '');
}

async function renderEditedClip(jobId: string, clipId: string): Promise<void> {
  const job = jobStore.get(jobId);
  const clip = job?.clips?.find((c) => c.id === clipId);
  if (!job || !clip) return;
  const workDir = path.join(config.workDir, `${jobId}-edit-${clipId}`);
  try {
    const data = readEditorData(jobId, clipId);
    const edit = readClipEdit(jobId, clipId);
    if (!data || !edit) throw new Error('Klippets redigeringsdata saknas.');
    if (!sourceAvailable(job)) throw new Error('Källvideon är borttagen, klippet kan inte renderas om.');
    updateClip(jobId, clipId, { renderState: { status: 'rendering', at: new Date().toISOString() } });

    const edges = { start: edit.start, end: edit.end };
    await refineWordTiming(job, data, edit, workDir);
    const analysed = data.analysis;
    if (
      needsFramingAnalysis(data.source) &&
      (!analysed || edit.start < analysed.start - 0.5 || edit.end > analysed.end + 0.5)
    ) {
      data.analysis = (await analyzeFraming(job.sourceVideoPath as string, edit.start, edit.end, data.source)) ?? analysed;
    }
    writeEditorData(jobId, clipId, data);
    if (edit.start !== edges.start || edit.end !== edges.end) {
      // Save the moved edges, unless the editor has saved new ones meanwhile.
      const latest = readClipEdit(jobId, clipId);
      if (latest && latest.start === edges.start && latest.end === edges.end) {
        writeClipEdit(jobId, clipId, { ...latest, start: edit.start, end: edit.end });
      }
    }

    const version = (clip.version ?? 1) + 1;
    const base = clipBaseName(clip.filename);
    const filename = `${base}_v${version}.mp4`;
    const outDir = jobOutputDir(jobId);
    const outPath = path.join(outDir, filename);
    const result = await renderClipEdit({
      sourcePath: job.sourceVideoPath as string,
      data,
      edit,
      outPath,
      workDir,
      name: base,
    });
    try {
      await generateThumbnail(outPath, path.join(outDir, `${base}_v${version}.jpg`));
    } catch (err) {
      console.warn(`[editor] thumbnail for ${filename} failed:`, err);
    }

    const previous = clip.filename;
    updateClip(jobId, clipId, {
      filename,
      version,
      start: edit.start,
      end: edit.end,
      durationSec: result.duration,
      layout: result.layout,
      renderState: undefined,
      editedAt: new Date().toISOString(),
    });
    for (const old of [previous, previous.replace(/\.mp4$/, '.jpg')]) {
      if (old !== filename) fs.rmSync(path.join(outDir, old), { force: true });
    }
  } catch (err) {
    console.error(`[editor] rendering ${jobId}/${clipId} failed:`, err);
    const message = err instanceof Error ? err.message.split('\n')[0] : String(err);
    updateClip(jobId, clipId, { renderState: { status: 'error', error: message, at: new Date().toISOString() } });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/** Queue a render of the clip's saved edit. Returns false if one is already on its way. */
export function queueClipRender(jobId: string, clipId: string): boolean {
  const clip = jobStore.get(jobId)?.clips?.find((c) => c.id === clipId);
  if (!clip) return false;
  if (clip.renderState && clip.renderState.status !== 'error') return false;
  updateClip(jobId, clipId, { renderState: { status: 'queued', at: new Date().toISOString() } });
  renderQueue.push(() => renderEditedClip(jobId, clipId));
  return true;
}

// ---------------------------------------------------------------------------
// Cleanup

/** Delete a job and everything it has on disk. */
export function deleteJob(jobId: string): void {
  for (const dir of jobDirs(jobId)) fs.rmSync(dir, { recursive: true, force: true });
  jobStore.delete(jobId);
}

/** Delete the source video (and the editor's preview files) of a job. */
export function dropSource(job: Job): void {
  fs.rmSync(path.join(config.sourcesDir, job.id), { recursive: true, force: true });
  for (const clip of job.clips ?? []) {
    fs.rmSync(proxyFile(job.id, clip.id, 'mp4'), { force: true });
    fs.rmSync(proxyFile(job.id, clip.id, 'webm'), { force: true });
    fs.rmSync(peaksFile(job.id, clip.id), { force: true });
  }
  jobStore.update(job.id, { sourceVideoPath: undefined, sourceDeletedAt: new Date().toISOString() });
}

/**
 * Delete source videos nobody has touched for SOURCE_RETENTION_DAYS, so the
 * disk doesn't fill up. Runs every hour.
 */
export function sweepExpiredSources(now = Date.now()): void {
  const maxAge = config.sourceRetentionDays * 24 * 60 * 60 * 1000;
  for (const job of jobStore.list()) {
    if (!job.sourceVideoPath || (job.status !== 'done' && job.status !== 'error')) continue;
    const busy = job.clips?.some((c) => c.renderState && c.renderState.status !== 'error');
    if (!busy && now - Date.parse(job.updatedAt) > maxAge) dropSource(job);
  }
}

const globalForSweep = globalThis as unknown as { __autoClipperSweep?: NodeJS.Timeout };
if (!globalForSweep.__autoClipperSweep) {
  const sweep = () => {
    try {
      sweepExpiredSources();
    } catch (err) {
      console.error('[editor] cleaning up old source videos failed:', err);
    }
  };
  globalForSweep.__autoClipperSweep = setInterval(sweep, 60 * 60 * 1000);
  globalForSweep.__autoClipperSweep.unref();
  setTimeout(sweep, 10_000).unref();
}
