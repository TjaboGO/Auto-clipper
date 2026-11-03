// "Exportera till Premiere / DaVinci": a folder per clip with the timeline
// (projekt.xml) and the media it uses, so the clip can be finished in a
// real editing program. Built in the background (it renders the video
// again, in better quality) and kept until the clip changes.
import fs from 'fs';
import path from 'path';
import { config } from './config';
import { run } from './exec';
import { musicTrack } from './brand';
import { clipEditable, readClipEdit, readEditorData, readRenderedEdit } from './editor';
import { clipFileBase, clipSubtitles } from './exports';
import { jobStore } from './jobStore';
import { buildXmeml, ffmpegRate, nleRate, type NleProject } from './nle';
import { jobEditorDir, jobOutputDir } from './paths';
import { brollPath, downloadVideo } from './pexels';
import { probeDuration, probeFrameRate } from './probe';
import { renderQueue } from './queue';
import { clipGraphics, renderClipEdit } from './render';
import { buildGraphicsGraph } from './renderGraph';
import { brollShows } from './edit/broll';
import { framePanels, OUTPUT_SIZES, resolveLayout } from './edit/layout';
import { keptRanges, outputDuration } from './edit/timeline';
import type { ClipEdit } from './edit/types';
import type { ZipEntry } from './zip';

/** Extra video before and after the clip, so its edges can be moved in the editing program. */
export const PROJECT_HANDLE = 2;

export interface ProjectState {
  status: 'none' | 'queued' | 'building' | 'ready' | 'error';
  /** What it's doing right now, while building. */
  step?: string;
  error?: string;
  /** Size of the download, once it's ready. */
  bytes?: number;
}

interface Manifest {
  /** The clip's video file when it was built: a new render makes the project old. */
  key: string;
  files: string[];
  builtAt: string;
}

// Builds on their way, per process (see jobStore.ts for why on globalThis).
const globalForProjects = globalThis as unknown as { __autoClipperProjects?: Map<string, ProjectState> };
const building = (globalForProjects.__autoClipperProjects ??= new Map());

function projectDir(jobId: string, clipId: string): string {
  return path.join(/* turbopackIgnore: true */ jobEditorDir(jobId), `${clipId}-project`);
}

function readManifest(dir: string): Manifest | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(/* turbopackIgnore: true */ dir, 'project.json'), 'utf8')) as Manifest;
  } catch {
    return null;
  }
}

/** A finished project for the clip as it is now, or null. */
function readyProject(jobId: string, clipId: string): { dir: string; manifest: Manifest } | null {
  const clip = jobStore.get(jobId)?.clips?.find((c) => c.id === clipId);
  if (!clip) return null;
  const dir = projectDir(jobId, clipId);
  const manifest = readManifest(dir);
  if (!manifest || manifest.key !== clip.filename) return null;
  if (!manifest.files.every((f) => fs.existsSync(path.join(/* turbopackIgnore: true */ dir, f)))) return null;
  return { dir, manifest };
}

export function projectState(jobId: string, clipId: string): ProjectState {
  const current = building.get(`${jobId}/${clipId}`);
  if (current && current.status !== 'error') return current;
  const ready = readyProject(jobId, clipId);
  if (ready) {
    const entries = projectEntries(jobId, clipId) ?? [];
    const bytes = entries.reduce((sum, e) => sum + (e.data ? e.data.length : fs.statSync(e.path as string).size), 0);
    return { status: 'ready', bytes };
  }
  return current ?? { status: 'none' };
}

/** Start building the project (if it isn't built or on its way). */
export function queueProjectBuild(jobId: string, clipId: string): ProjectState {
  const state = projectState(jobId, clipId);
  if (state.status === 'queued' || state.status === 'building' || state.status === 'ready') return state;
  const queued: ProjectState = { status: 'queued' };
  building.set(`${jobId}/${clipId}`, queued);
  renderQueue.push(() => buildProject(jobId, clipId));
  return queued;
}

/** The ZIP's files: the project folder, plus the finished clip to compare with. */
export function projectEntries(jobId: string, clipId: string): ZipEntry[] | null {
  const job = jobStore.get(jobId);
  const index = job?.clips?.findIndex((c) => c.id === clipId) ?? -1;
  const ready = readyProject(jobId, clipId);
  if (!job?.clips || index < 0 || !ready) return null;
  const clip = job.clips[index];
  const folder = `${clipFileBase(clip, index)} - projekt`;
  const entries: ZipEntry[] = ready.manifest.files.map((f) => ({
    name: `${folder}/${f}`,
    path: path.join(/* turbopackIgnore: true */ ready.dir, f),
  }));
  const finished = path.join(/* turbopackIgnore: true */ jobOutputDir(jobId), path.basename(clip.filename));
  if (fs.existsSync(finished)) entries.push({ name: `${folder}/fardigt-klipp.mp4`, path: finished });
  return entries;
}

/** The clip with nothing over the picture and nothing cut out, for the framed video. */
function plainEdit(edit: ClipEdit, start: number, end: number): ClipEdit {
  return {
    ...edit,
    start,
    end,
    deleted: [],
    removeFillers: false,
    removePauses: false,
    captions: { ...edit.captions, enabled: false, emojis: false },
    title: { ...edit.title, enabled: false },
    logo: { ...edit.logo, enabled: false },
    translation: null,
    zoom: 'off',
    music: null,
    broll: [],
    progress: { ...edit.progress, enabled: false },
  };
}

const README = (p: { graphics: boolean; broll: number; music: boolean; subtitles: boolean }) =>
  [
    'Auto Clipper: klippet som projekt för Premiere Pro och DaVinci Resolve',
    '',
    'Filerna',
    '  projekt.xml        tidslinjen (Final Cut Pro 7 XML, som båda programmen läser)',
    `  video.mp4          videon inramad i klippets format, utan text och utan klipp, med ${PROJECT_HANDLE} s extra i början och slutet`,
    ...(p.graphics ? ['  grafik.mov         texter, rubrik, logga, emojis och förloppsstapel på ett genomskinligt lager (ProRes 4444)'] : []),
    ...(p.broll ? [`  broll-1.mp4 ...    B-roll, redan beskuren till klippets format (${p.broll} st)`] : []),
    ...(p.music ? ['  musik.wav          bakgrundsmusiken i vald volym (sänks inte automatiskt när någon pratar)'] : []),
    ...(p.subtitles ? ['  text.srt           undertexterna, om du vill ha dem som ett textspår'] : []),
    '  fardigt-klipp.mp4  klippet som appen renderade, att jämföra med',
    '',
    'Premiere Pro',
    '  1. Packa upp ZIP-filen.',
    '  2. Arkiv > Importera (File > Import) och välj projekt.xml.',
    '  3. Frågar Premiere efter filerna: klicka Leta upp (Locate) och välj video.mp4 i mappen. Resten hittas då.',
    ...(p.subtitles ? ['  4. Undertexter som textspår: importera text.srt och dra in den på tidslinjen.'] : []),
    '',
    'DaVinci Resolve',
    '  1. Packa upp ZIP-filen.',
    '  2. File > Import > Timeline och välj projekt.xml. Låt "Automatically import source clips into media pool" vara på.',
    '  3. Saknas filer: markera klippen i Media Pool, högerklicka, välj Relink och peka på mappen.',
    ...(p.subtitles ? ['  4. Undertexter: File > Import > Subtitle och välj text.srt.'] : []),
    '',
    'Tidslinjen',
    '  V1     videon, med borttagna ord och pauser bortklippta (dra i kanterna för att få tillbaka dem)',
    ...(p.broll ? ['  V2     B-roll'] : []),
    ...(p.graphics ? [`  V${p.broll ? 3 : 2}     grafiken`] : []),
    '  A1-A2  ljudet',
    ...(p.music ? ['  A3-A4  musiken'] : []),
    '',
    'Automatisk zoom följer inte med. Ändrar du klippen på tidslinjen hamnar texterna i grafik.mov inte längre rätt.',
    '',
  ].join('\n');

async function buildProject(jobId: string, clipId: string): Promise<void> {
  const key = `${jobId}/${clipId}`;
  const step = (text: string) => building.set(key, { status: 'building', step: text });
  const job = jobStore.get(jobId);
  const clip = job?.clips?.find((c) => c.id === clipId);
  if (!job || !clip) {
    building.delete(key);
    return;
  }
  const dir = projectDir(jobId, clipId);
  const tmp = `${dir}.tmp`;
  const workDir = path.join(/* turbopackIgnore: true */ config.workDir, `${jobId}-project-${clipId}`);
  try {
    step('Förbereder ...');
    const data = readEditorData(jobId, clipId);
    const edit = readRenderedEdit(jobId, clipId) ?? readClipEdit(jobId, clipId);
    if (!data || !edit) throw new Error('Klippets redigeringsdata saknas.');
    if (!clipEditable(job, clipId) || !job.sourceVideoPath) {
      throw new Error('Källvideon är borttagen, så projektet kan inte byggas.');
    }
    const sourcePath = job.sourceVideoPath;
    const kept = keptRanges(edit, data.words);
    if (kept.length === 0) throw new Error('Hela klippet är bortklippt.');
    const duration = outputDuration(kept);
    const rate = nleRate(await probeFrameRate(sourcePath));
    const r = ffmpegRate(rate);
    const out = OUTPUT_SIZES[edit.aspect];

    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    const file = (name: string) => path.join(/* turbopackIgnore: true */ tmp, name);
    const files: string[] = [];

    // The framed video: the whole clip plus a little on each side.
    step('Renderar videon ...');
    const lowest = Math.max(0, data.window.start);
    const highest = Math.min(data.window.end, data.source.duration);
    const mediaStart = Math.min(edit.start, Math.max(lowest, edit.start - PROJECT_HANDLE));
    const mediaEnd = Math.max(edit.end, Math.min(highest, edit.end + PROJECT_HANDLE));
    await renderClipEdit({
      sourcePath,
      data,
      edit: plainEdit(edit, mediaStart, mediaEnd),
      outPath: file('video.mp4'),
      workDir,
      name: 'video',
      master: { rate: r },
    });
    files.push('video.mp4');

    // The graphics on their own, see-through.
    const { layout } = resolveLayout(edit.layout, edit.aspect, data.source, data.analysis);
    const panels = framePanels({ layout, source: data.source, out, analysis: data.analysis, swap: edit.splitSwap, panelSize: edit.panelSize });
    const graphics = clipGraphics({ data, edit, kept, layout, panels, workDir, name: 'grafik', loopFor: duration });
    if (graphics.visible) {
      step('Renderar texterna ...');
      const graphPath = path.join(/* turbopackIgnore: true */ workDir, 'grafik.filtergraph');
      fs.writeFileSync(graphPath, buildGraphicsGraph({ ...graphics, out }, duration), 'utf-8');
      await run(
        'ffmpeg',
        [
          '-y',
          '-f', 'lavfi',
          '-i', `color=c=black@0.0:s=${out.w}x${out.h}:r=${r}:d=${duration.toFixed(3)},format=rgba`,
          ...graphics.inputs,
          '-filter_complex_script', graphPath,
          '-map', '[vout]',
          '-t', duration.toFixed(3),
          '-c:v', 'prores_ks',
          '-profile:v', '4444',
          '-vendor', 'apl0',
          '-pix_fmt', 'yuva444p10le',
          file('grafik.mov'),
        ],
        {},
        Math.max(600, 20 * duration) * 1000,
      );
      files.push('grafik.mov');
    }

    // Stock video, cropped to fill the frame, one file each.
    const broll: NonNullable<NleProject['broll']> = [];
    const shows = brollShows(edit, graphics.spoken, duration);
    if (shows.length) step('Förbereder B-roll ...');
    for (const show of shows) {
      await downloadVideo(show.video).catch((err) => console.warn('[project] B-roll missing:', err));
      const source = brollPath(show.video.file);
      if (!source || !fs.existsSync(source)) continue;
      const name = `broll-${broll.length + 1}.mp4`;
      const length = show.end - show.start;
      await run('ffmpeg', [
        '-y',
        '-stream_loop', '-1',
        '-t', length.toFixed(3),
        '-i', source,
        '-vf', `scale=${out.w}:${out.h}:force_original_aspect_ratio=increase,crop=${out.w}:${out.h},setsar=1`,
        '-r', r,
        '-an',
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '18',
        '-pix_fmt', 'yuv420p',
        file(name),
      ]);
      files.push(name);
      broll.push({ file: name, duration: length, start: show.start });
    }

    // The music at its level, as long as the clip.
    const track = edit.music ? musicTrack(edit.music.track) : null;
    if (track && edit.music) {
      step('Förbereder musiken ...');
      const fadeOut = Math.min(1.5, duration / 3);
      await run('ffmpeg', [
        '-y',
        '-stream_loop', '-1',
        '-t', duration.toFixed(3),
        '-i', track.path,
        '-af',
        `volume=${edit.music.volume},afade=t=in:st=0:d=${Math.min(1, duration / 4).toFixed(3)},` +
          `afade=t=out:st=${Math.max(0, duration - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}`,
        '-ac', '2',
        '-ar', '48000',
        '-c:a', 'pcm_s16le',
        file('musik.wav'),
      ]);
      files.push('musik.wav');
    }

    const srt = clipSubtitles(jobId, clipId, 'srt');
    if (srt) {
      fs.writeFileSync(file('text.srt'), srt, 'utf-8');
      files.push('text.srt');
    }

    step('Skriver tidslinjen ...');
    const media = async (name: string) => probeDuration(file(name));
    const project: NleProject = {
      name: clip.title,
      rate,
      width: out.w,
      height: out.h,
      video: { file: 'video.mp4', duration: await media('video.mp4'), start: mediaStart, hasAudio: data.source.hasAudio },
      kept,
      graphics: graphics.visible ? { file: 'grafik.mov', duration: await media('grafik.mov') } : null,
      broll,
      music: files.includes('musik.wav') ? { file: 'musik.wav', duration: await media('musik.wav') } : null,
    };
    fs.writeFileSync(file('projekt.xml'), buildXmeml(project), 'utf-8');
    fs.writeFileSync(
      file('las-mig.txt'),
      README({ graphics: graphics.visible, broll: broll.length, music: !!project.music, subtitles: !!srt }),
      'utf-8',
    );
    files.unshift('projekt.xml', 'las-mig.txt');
    const manifest: Manifest = { key: clip.filename, files, builtAt: new Date().toISOString() };
    fs.writeFileSync(file('project.json'), JSON.stringify(manifest, null, 2), 'utf-8');

    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(tmp, dir);
    building.delete(key);
  } catch (err) {
    console.error(`[project] building ${key} failed:`, err);
    const message = err instanceof Error ? err.message.split('\n')[0] : String(err);
    building.set(key, { status: 'error', error: message });
    fs.rmSync(tmp, { recursive: true, force: true });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
