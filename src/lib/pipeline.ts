import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { config } from './config';
import { jobStore } from './jobStore';
import { jobWorkDir, jobOutputDir, jobSourceDir } from './paths';
import { renderQueue } from './queue';
import { extractAudio, generateThumbnail } from './ffmpeg';
import { probeDimensions, probeDuration, probeHasAudio } from './probe';
import { transcribeAudio, findHighlights } from './gemini';
import { analyzeFraming } from './smartCrop';
import { renderClipEdit } from './render';
import { dropSource, sourceAvailable, writeClipEdit, writeEditorData } from './editor';
import { buildEditorWords, editWindow, keywordWordIds, needsFramingAnalysis } from './editorWords';
import { defaultEdit } from './edit/presets';
import { clipWords } from './edit/timeline';
import type { SourceInfo } from './edit/types';
import {
  clipLength,
  defaultJobOptions,
  formatClock,
  MIN_RANGE_SECONDS,
  type ClipLengthId,
  type JobOptions,
} from './jobOptions';
import { computeWordTimings, whisperModelIsCached, type ClipTiming } from './wordTiming';
import { downloadFromUrl } from './youtube';
import type { ClipSuggestion, JobStatus, RenderedClip, TranscriptSegment } from './types';

function logStep(jobId: string, step: JobStatus, message: string): void {
  jobStore.update(jobId, { status: step });
  logProgress(jobId, step, message);
}

function logProgress(jobId: string, step: JobStatus, message: string): void {
  jobStore.appendProgress(jobId, { step, message, at: new Date().toISOString() });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function describeTiming(clips: ClipTiming[], problem?: string): string {
  const exact = clips.filter((c) => c.exact).length;
  if (exact === clips.length) return `Exakt ordtiming klar för alla ${clips.length} klipp.`;
  if (exact > 0) {
    return `Exakt ordtiming för ${exact} av ${clips.length} klipp, resten använder uppskattad timing.`;
  }
  return `Kunde inte ta fram exakt ordtiming${problem ? ` (${problem})` : ''}. Använder uppskattad timing.`;
}

/** Put a freshly-created job on the background render queue. */
export function enqueueJob(jobId: string): void {
  renderQueue.push(() => processJob(jobId));
}

/** Split [start, end] into equal chunks no longer than maxSeconds each. */
function planChunks(range: { start: number; end: number }, maxSeconds: number): { start: number; duration: number }[] {
  const length = range.end - range.start;
  const count = Math.max(1, Math.ceil(length / maxSeconds));
  const size = length / count;
  return Array.from({ length: count }, (_, i) => ({ start: range.start + i * size, duration: size }));
}

/**
 * Transcribe [start, end] of the video a chunk at a time and stitch the
 * pieces back onto the source timeline. Each chunk's segments are already
 * clamped to the chunk, so the stitched transcript stays in order without
 * overlaps.
 */
async function transcribeInChunks(
  jobId: string,
  sourcePath: string,
  range: { start: number; end: number },
  workDir: string,
): Promise<TranscriptSegment[]> {
  const chunks = planChunks(range, config.transcribeChunkSeconds);
  const transcript: TranscriptSegment[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const { start, duration } = chunks[i];
    if (chunks.length > 1) {
      logProgress(jobId, 'transcribing', `Transkriberar del ${i + 1} av ${chunks.length} ...`);
    }
    const audioPath = path.join(workDir, `audio_${i + 1}.mp3`);
    await extractAudio(sourcePath, audioPath, { start, duration });
    const segments = await transcribeAudio(audioPath, duration);
    for (const s of segments) {
      transcript.push({ start: s.start + start, end: s.end + start, text: s.text });
    }
    fs.rmSync(audioPath, { force: true });
  }
  return transcript;
}

/** Add a finished clip to the job, re-reading it: the editor may have changed other clips meanwhile. */
function appendClip(jobId: string, clip: RenderedClip): void {
  const clips = jobStore.get(jobId)?.clips ?? [];
  jobStore.update(jobId, { clips: [...clips, clip] });
}

/** The number the next clip's files get (clip_7.mp4 after clip_6.mp4 or clip_6_v2.mp4). */
function nextClipIndex(clips: RenderedClip[]): number {
  return clips.reduce((max, c) => Math.max(max, Number(/^clip_(\d+)/.exec(c.filename)?.[1] ?? 0)), 0) + 1;
}

/**
 * Word timing and rendering for a batch of picked moments: Whisper listens
 * to them (so each caption word lights up when it's said and the clips
 * start and end on real word boundaries), then each clip is framed and
 * rendered through the same path the editor uses, with the job's format,
 * caption style and the AI's key words highlighted. Each clip's words,
 * framing and settings are saved for the editor. One broken clip doesn't
 * stop the others.
 */
async function renderSuggestions(opts: {
  jobId: string;
  sourcePath: string;
  source: SourceInfo;
  transcript: TranscriptSegment[];
  suggestions: ClipSuggestion[];
  options: JobOptions;
  firstIndex: number;
  workDir: string;
}): Promise<{ rendered: number; failures: string[] }> {
  const { jobId, sourcePath, source, transcript, suggestions, options, firstIndex, workDir } = opts;
  if (config.wordTiming) {
    logProgress(
      jobId,
      'rendering',
      whisperModelIsCached()
        ? 'Tar fram exakt ordtiming med Whisper ...'
        : 'Laddar ner Whisper-modellen för exakt ordtiming (bara första gången) ...',
    );
  }
  const timing = await computeWordTimings({
    sourcePath,
    durationSec: source.duration,
    clips: suggestions,
    transcript,
    workDir,
  });
  if (config.wordTiming) {
    logProgress(jobId, 'rendering', describeTiming(timing.clips, timing.problem));
  }

  const outDir = jobOutputDir(jobId);
  const failures: string[] = [];
  let rendered = 0;
  for (let i = 0; i < suggestions.length; i++) {
    const suggestion = suggestions[i];
    const { start, end, exact } = timing.clips[i];
    const index = firstIndex + i;
    const id = crypto.randomUUID();
    const filename = `clip_${index}.mp4`;
    const outPath = path.join(outDir, filename);

    let layout: RenderedClip['layout'];
    let clipDuration = end - start;
    try {
      const window = editWindow({ start, end }, source.duration);
      const analysis = needsFramingAnalysis(source) ? await analyzeFraming(sourcePath, start, end, source) : null;
      const data = {
        v: 1 as const,
        window,
        words: buildEditorWords(transcript, window, timing.clips[i]),
        source,
        analysis,
      };
      const edit = defaultEdit({
        start,
        end,
        title: suggestion.title,
        aspect: options.aspect,
        captionPreset: options.captionPreset,
      });
      if (options.keywords && suggestion.keywords?.length) {
        for (const wordId of keywordWordIds(clipWords(data.words, edit), suggestion.keywords)) {
          edit.words[wordId] = { emphasis: true };
        }
      }
      const result = await renderClipEdit({ sourcePath, data, edit, outPath, workDir, name: `clip_${index}` });
      layout = result.layout;
      clipDuration = result.duration;
      writeEditorData(jobId, id, data);
      writeClipEdit(jobId, id, edit);
    } catch (err) {
      console.error(`[pipeline] job ${jobId}: rendering ${filename} failed:`, err);
      failures.push(errorMessage(err));
      logProgress(
        jobId,
        'rendering',
        `Klipp ${index} ("${suggestion.title}") misslyckades: ${errorMessage(err).split('\n')[0]}`,
      );
      continue;
    }

    try {
      await generateThumbnail(outPath, path.join(outDir, `clip_${index}.jpg`));
    } catch (err) {
      console.warn(`[pipeline] thumbnail generation failed for ${filename}:`, err);
    }

    appendClip(jobId, {
      ...suggestion,
      start,
      end,
      id,
      filename,
      durationSec: clipDuration,
      wordTiming: exact ? 'exact' : 'estimated',
      layout,
      version: 1,
    });
    rendered++;
    logProgress(
      jobId,
      'rendering',
      `Klar: "${suggestion.title}" (${i + 1}/${suggestions.length}${layout === 'split' ? ', split screen' : ''})`,
    );
  }
  return { rendered, failures };
}

/**
 * Full pipeline for one job: ingest -> transcribe (all of the video, or the
 * part asked for) -> pick highlights (the best, or the best about a topic)
 * -> render each clip. Every step updates the job in jobStore so the
 * frontend's polling can show live progress. The source video is kept so
 * clips can be edited and rendered again.
 */
export async function processJob(jobId: string): Promise<void> {
  const job = jobStore.get(jobId);
  if (!job) {
    console.error(`[pipeline] processJob called for unknown job ${jobId}`);
    return;
  }
  const options = job.options ?? defaultJobOptions();

  const workDir = jobWorkDir(jobId);
  try {
    // 1. Ingest source video: either already-uploaded file, or a YouTube URL
    //    we need to fetch first with yt-dlp.
    let sourcePath = job.sourceVideoPath;
    if (job.source.type === 'youtube') {
      logStep(jobId, 'downloading', `Laddar ner videon från ${job.source.url} ...`);
      sourcePath = await downloadFromUrl(job.source.url, jobSourceDir(jobId));
      jobStore.update(jobId, { sourceVideoPath: sourcePath });
    }
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      throw new Error('Källvideon saknas eller kunde inte hämtas.');
    }

    let durationSec: number;
    try {
      durationSec = await probeDuration(sourcePath);
    } catch (err) {
      console.error(`[pipeline] job ${jobId}: ffprobe could not read the source:`, err);
      throw new Error('Kunde inte läsa videofilen. Kontrollera att det är en giltig video.');
    }
    jobStore.update(jobId, { sourceDurationSec: durationSec });
    if (!(await probeHasAudio(sourcePath))) {
      throw new Error('Videon har inget ljudspår, så det finns inget tal att transkribera.');
    }
    const source: SourceInfo = { ...(await probeDimensions(sourcePath)), duration: durationSec, hasAudio: true };

    // Only part of the video, if that's what was asked for.
    const range = options.range
      ? { start: Math.min(options.range.start, durationSec), end: Math.min(options.range.end, durationSec) }
      : { start: 0, end: durationSec };
    if (range.end - range.start < Math.min(MIN_RANGE_SECONDS, durationSec)) {
      throw new Error(
        `Den valda delen (${formatClock(range.start)}-${formatClock(range.end)}) ligger utanför videon eller är för kort. Videon är ${formatClock(durationSec)} lång.`,
      );
    }

    // 2. Transcribe the audio with Gemini, a chunk at a time.
    logStep(
      jobId,
      'transcribing',
      options.range
        ? `Transkriberar ${formatClock(range.start)}-${formatClock(range.end)} av videon med Gemini ...`
        : 'Transkriberar ljudet med Gemini ...',
    );
    const transcript = await transcribeInChunks(jobId, sourcePath, range, workDir);
    if (transcript.length === 0) {
      throw new Error('Gemini hittade inget tal i videon.');
    }
    jobStore.update(jobId, { transcript });

    // 3. Ask Gemini to act as an editor and pick the best moments.
    const length = clipLength(options.clipLength);
    logStep(
      jobId,
      'analyzing',
      options.topic ? `Letar efter ögonblick om "${options.topic}" ...` : 'Hittar de bästa klippen ...',
    );
    const suggestions = await findHighlights(transcript, {
      clipCount: job.clipCount,
      sourceDurationSec: durationSec,
      minSeconds: length.min,
      maxSeconds: length.max,
      topic: options.topic,
    });
    if (suggestions.length === 0) {
      throw new Error(
        options.topic
          ? `Hittade inga ögonblick om "${options.topic}" i videon. Prova ett annat ämne eller lämna sökrutan tom.`
          : 'Gemini hittade inga ögonblick som passade som klipp.',
      );
    }
    jobStore.update(jobId, { suggestions });

    // 4-5. Word timing, then render each clip.
    logStep(jobId, 'rendering', `Renderar ${suggestions.length} klipp ...`);
    const { rendered, failures } = await renderSuggestions({
      jobId,
      sourcePath,
      source,
      transcript,
      suggestions,
      options,
      firstIndex: 1,
      workDir,
    });
    if (rendered === 0) {
      throw new Error(`Inget klipp kunde renderas. Första felet: ${failures[0]}`);
    }

    jobStore.update(jobId, { status: 'done', finishedAt: new Date().toISOString() });
    logProgress(
      jobId,
      'done',
      failures.length > 0
        ? `Klart! ${rendered} av ${suggestions.length} klipp blev klara.`
        : 'Klart! Alla klipp är redo att laddas ner.',
    );
    // Without a retention period there's no editing: free the disk now.
    if (config.sourceRetentionDays === 0) {
      const finished = jobStore.get(jobId);
      if (finished) dropSource(finished);
    }
  } catch (err) {
    const message = errorMessage(err);
    console.error(`[pipeline] job ${jobId} failed:`, err);
    jobStore.update(jobId, { status: 'error', error: message, sourceVideoPath: undefined });
    logProgress(jobId, 'error', message);
    // Nothing to edit in a failed job: its source video and editor files go.
    fs.rmSync(path.join(config.sourcesDir, jobId), { recursive: true, force: true });
    fs.rmSync(path.join(config.editorDir, jobId), { recursive: true, force: true });
  } finally {
    // Intermediate files (audio chunks, subtitles) are only needed while the
    // job runs.
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

export interface SearchRequest {
  topic: string;
  clipCount: number;
  clipLength: ClipLengthId;
}

/** Whether a finished job can be searched for more clips (transcript and source still there). */
export function canSearch(jobId: string): boolean {
  const job = jobStore.get(jobId);
  return !!job && job.status === 'done' && !!job.transcript?.length && sourceAvailable(job);
}

/** Put a search for more clips in an existing job on the queue. */
export function enqueueSearch(jobId: string, request: SearchRequest): void {
  const job = jobStore.get(jobId);
  // finishedAt tells a restart that this is a search in a finished job (older jobs lack it).
  jobStore.update(jobId, { status: 'queued', finishedAt: job?.finishedAt ?? job?.updatedAt });
  logProgress(
    jobId,
    'queued',
    request.topic ? `Ny sökning: "${request.topic}". I kö ...` : 'Letar efter fler klipp. I kö ...',
  );
  renderQueue.push(() => searchMore(jobId, request));
}

function finishSearch(jobId: string, request: SearchRequest, added: number, message: string): void {
  jobStore.update(jobId, {
    status: 'done',
    lastSearch: { topic: request.topic, at: new Date().toISOString(), added, message },
  });
  logProgress(jobId, 'done', message);
}

/**
 * Find more clips in a finished job: ask Gemini again on the transcript it
 * already has (the best moments not clipped yet, or moments about a topic)
 * and render the new picks next to the old clips. No new transcription, so
 * it's quick.
 */
async function searchMore(jobId: string, request: SearchRequest): Promise<void> {
  const job = jobStore.get(jobId);
  if (!job) return;
  const workDir = jobWorkDir(jobId);
  try {
    if (!job.transcript?.length || !job.sourceVideoPath || !sourceAvailable(job)) {
      throw new Error('Källvideon eller transkriberingen finns inte kvar.');
    }
    const options = job.options ?? defaultJobOptions();
    const sourcePath = job.sourceVideoPath;
    const durationSec = job.sourceDurationSec ?? (await probeDuration(sourcePath));
    const source: SourceInfo = { ...(await probeDimensions(sourcePath)), duration: durationSec, hasAudio: true };
    const length = clipLength(request.clipLength);

    logStep(
      jobId,
      'analyzing',
      request.topic ? `Letar efter ögonblick om "${request.topic}" ...` : 'Letar efter fler bra ögonblick ...',
    );
    const existing = job.clips ?? [];
    const suggestions = await findHighlights(job.transcript, {
      clipCount: request.clipCount,
      sourceDurationSec: durationSec,
      minSeconds: length.min,
      maxSeconds: length.max,
      topic: request.topic,
      exclude: existing.map((c) => ({ start: c.start, end: c.end })),
    });
    if (suggestions.length === 0) {
      finishSearch(
        jobId,
        request,
        0,
        request.topic ? `Hittade inga nya ögonblick om "${request.topic}".` : 'Hittade inga fler ögonblick som passade.',
      );
      return;
    }
    jobStore.update(jobId, { suggestions: [...(job.suggestions ?? []), ...suggestions] });

    logStep(jobId, 'rendering', `Renderar ${suggestions.length} nya klipp ...`);
    const { rendered, failures } = await renderSuggestions({
      jobId,
      sourcePath,
      source,
      transcript: job.transcript,
      suggestions,
      options,
      firstIndex: nextClipIndex(existing),
      workDir,
    });
    finishSearch(
      jobId,
      request,
      rendered,
      rendered > 0
        ? `Klart! ${rendered} ${rendered === 1 ? 'nytt klipp' : 'nya klipp'}${request.topic ? ` om "${request.topic}"` : ''}.`
        : `Inga nya klipp kunde renderas. Första felet: ${failures[0]}`,
    );
  } catch (err) {
    console.error(`[pipeline] search in job ${jobId} failed:`, err);
    finishSearch(jobId, request, 0, `Sökningen misslyckades: ${errorMessage(err)}`);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

export function newJobId(): string {
  return crypto.randomUUID();
}
