// A cover image for a clip (for a Reels/TikTok cover or a thumbnail): one
// moment of the clip, framed like the clip, with its title over it. Made
// by rendering a sliver of the clip through the normal render, so the
// framing, logo and title look exactly like the video.
import fs from 'fs';
import path from 'path';
import { config } from './config';
import { run } from './exec';
import { readClipEdit, readEditorData } from './editor';
import { jobStore } from './jobStore';
import { jobOutputDir } from './paths';
import { renderClipEdit } from './render';
import type { ClipEdit } from './edit/types';

export interface CoverMoment {
  /** Source seconds. */
  t: number;
  /** A small picture of that moment (the whole source frame). */
  url: string;
  face: boolean;
}

/**
 * The best moments of the clip for a cover: a big, sharp, well lit face,
 * spread over the clip (scripts/best_frames.py). Each gets a small preview.
 */
export async function suggestCoverMoments(jobId: string, clipId: string, count = 4): Promise<CoverMoment[]> {
  const job = jobStore.get(jobId);
  const clip = job?.clips?.find((c) => c.id === clipId);
  const edit = readClipEdit(jobId, clipId);
  if (!job?.sourceVideoPath || !clip || !edit || !fs.existsSync(job.sourceVideoPath)) {
    throw new Error('Källvideon behövs för att hitta bilder, och den finns inte kvar.');
  }
  const { stdout } = await run(
    'python3',
    [config.bestFramesScript, job.sourceVideoPath, '--start', String(edit.start), '--end', String(edit.end), '--model', config.faceModel, '--count', String(count)],
    {},
    5 * 60 * 1000,
  );
  const parsed = JSON.parse(stdout.trim().split('\n').pop() || '{}') as { frames?: { t: number; face: boolean }[] };
  const base = clip.filename.replace(/(_v\d+)?\.mp4$/, '');
  const outDir = jobOutputDir(jobId);
  const moments: CoverMoment[] = [];
  for (const [i, frame] of (parsed.frames ?? []).entries()) {
    if (!Number.isFinite(frame.t)) continue;
    const name = `${base}_moment_${i + 1}.jpg`;
    // Seek close by quickly, then exactly: the right frame, also in a long video.
    const before = Math.max(0, frame.t - 2);
    await run('ffmpeg', [
      '-y', '-ss', String(before), '-i', job.sourceVideoPath, '-ss', String(frame.t - before),
      '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', path.join(/* turbopackIgnore: true */ outDir, name),
    ]);
    moments.push({ t: frame.t, url: `/api/clips/${jobId}/${name}?v=${Date.now()}`, face: !!frame.face });
  }
  return moments;
}

/** How much of the clip is rendered to take the picture from. */
const SLIVER = 0.5;

export async function makeCover(jobId: string, clipId: string, at: number, opts: { title: boolean; text?: string }): Promise<string> {
  const job = jobStore.get(jobId);
  const clip = job?.clips?.find((c) => c.id === clipId);
  const data = readEditorData(jobId, clipId);
  const edit = readClipEdit(jobId, clipId);
  if (!job?.sourceVideoPath || !clip || !data || !edit || !fs.existsSync(job.sourceVideoPath)) {
    throw new Error('Källvideon behövs för att göra ett omslag, och den finns inte kvar.');
  }
  const start = Math.min(Math.max(at, data.window.start), data.window.end - SLIVER);
  const text = (opts.text ?? edit.title.text).replace(/\s+/g, ' ').trim().slice(0, 120);
  const still: ClipEdit = {
    ...edit,
    start,
    end: start + SLIVER,
    deleted: [],
    removeFillers: false,
    removePauses: false,
    captions: { ...edit.captions, enabled: false, emojis: false },
    title: { enabled: opts.title && text !== '', text, duration: 'all' },
    zoom: 'off',
    transition: 'none',
    progress: { ...edit.progress, enabled: false },
    music: null,
    broll: [],
  };
  const workDir = path.join(/* turbopackIgnore: true */ config.workDir, `${jobId}-cover-${clipId}`);
  const sliver = path.join(/* turbopackIgnore: true */ workDir, 'cover.mp4');
  const name = `${clip.filename.replace(/(_v\d+)?\.mp4$/, '')}_cover.jpg`;
  const out = path.join(/* turbopackIgnore: true */ jobOutputDir(jobId), name);
  try {
    await renderClipEdit({ sourcePath: job.sourceVideoPath, data, edit: still, outPath: sliver, workDir, name: 'cover' });
    await run('ffmpeg', ['-y', '-ss', '0.1', '-i', sliver, '-frames:v', '1', '-q:v', '2', out]);
    return name;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
