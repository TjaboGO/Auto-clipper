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
import { dropSource, writeClipEdit, writeEditorData } from './editor';
import { buildEditorWords, editWindow, needsFramingAnalysis } from './editorWords';
import { defaultEdit } from './edit/presets';
import type { SourceInfo } from './edit/types';
import { computeWordTimings, whisperModelIsCached, type ClipTiming } from './wordTiming';
import { downloadFromUrl } from './youtube';
import type { Job, JobStatus, RenderedClip, TranscriptSegment } from './types';

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

/** Split [0, duration] into equal chunks no longer than maxSeconds each. */
function planChunks(durationSec: number, maxSeconds: number): { start: number; duration: number }[] {
  const count = Math.max(1, Math.ceil(durationSec / maxSeconds));
  const size = durationSec / count;
  return Array.from({ length: count }, (_, i) => ({ start: i * size, duration: size }));
}

/**
 * Transcribe the whole video a chunk at a time and stitch the pieces back
 * onto the source timeline. Each chunk's segments are already clamped to
 * the chunk, so the stitched transcript stays in order without overlaps.
 */
async function transcribeInChunks(
  jobId: string,
  sourcePath: string,
  durationSec: number,
  workDir: string,
): Promise<TranscriptSegment[]> {
  const chunks = planChunks(durationSec, config.transcribeChunkSeconds);
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

/**
 * Full pipeline for one job: ingest -> transcribe -> pick highlights ->
 * render each clip (smart crop + burned captions). Every step updates the
 * job in jobStore so the frontend's polling can show live progress. Each
 * clip's words, framing and settings are saved for the editor, and the
 * source video is kept so clips can be rendered again.
 */
export async function processJob(jobId: string): Promise<void> {
  const job = jobStore.get(jobId);
  if (!job) {
    console.error(`[pipeline] processJob called for unknown job ${jobId}`);
    return;
  }

  const workDir = jobWorkDir(jobId);
  try {
    const outDir = jobOutputDir(jobId);

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

    // 2. Transcribe the audio with Gemini, a chunk at a time.
    logStep(jobId, 'transcribing', 'Transkriberar ljudet med Gemini ...');
    const transcript = await transcribeInChunks(jobId, sourcePath, durationSec, workDir);
    if (transcript.length === 0) {
      throw new Error('Gemini hittade inget tal i videon.');
    }
    jobStore.update(jobId, { transcript });

    // 3. Ask Gemini to act as an editor and pick the best moments.
    logStep(jobId, 'analyzing', 'Hittar de bästa klippen ...');
    const suggestions = await findHighlights(transcript, {
      clipCount: job.clipCount,
      sourceDurationSec: durationSec,
    });
    if (suggestions.length === 0) {
      throw new Error('Gemini hittade inga ögonblick som passade som klipp.');
    }
    jobStore.update(jobId, { suggestions });

    // 4. Exact word timing: Whisper listens to the picked clips, so each
    //    caption word lights up when it's said and the clips start and end
    //    on real word boundaries. Falls back to estimated timing on its own.
    logStep(jobId, 'rendering', `Renderar ${suggestions.length} klipp ...`);
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
      durationSec,
      clips: suggestions,
      transcript,
      workDir,
    });
    if (config.wordTiming) {
      logProgress(jobId, 'rendering', describeTiming(timing.clips, timing.problem));
    }

    // 5. Render each clip: face-tracked vertical crop + burned-in captions,
    //    through the same path the editor renders with. One broken clip
    //    shouldn't throw away the others.
    const clips: RenderedClip[] = [];
    const failures: string[] = [];
    for (let i = 0; i < suggestions.length; i++) {
      const suggestion = suggestions[i];
      const { start, end, exact } = timing.clips[i];
      const index = i + 1;
      const id = crypto.randomUUID();
      const filename = `clip_${index}.mp4`;
      const outPath = path.join(outDir, filename);

      let layout: RenderedClip['layout'];
      let clipDuration = end - start;
      try {
        const window = editWindow({ start, end }, durationSec);
        const analysis = needsFramingAnalysis(source)
          ? await analyzeFraming(sourcePath, start, end, source)
          : null;
        const data = {
          v: 1 as const,
          window,
          words: buildEditorWords(transcript, window, timing.clips[i]),
          source,
          analysis,
        };
        const edit = defaultEdit({ start, end, title: suggestion.title });
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

      clips.push({
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

      jobStore.update(jobId, { clips: [...clips] });
      logProgress(
        jobId,
        'rendering',
        `Klar: "${suggestion.title}" (${index}/${suggestions.length}${layout === 'split' ? ', split screen' : ''})`,
      );
    }

    if (clips.length === 0) {
      throw new Error(`Inget klipp kunde renderas. Första felet: ${failures[0]}`);
    }

    jobStore.update(jobId, { status: 'done' });
    logProgress(
      jobId,
      'done',
      failures.length > 0
        ? `Klart! ${clips.length} av ${suggestions.length} klipp blev klara.`
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

export function newJobId(): string {
  return crypto.randomUUID();
}

export type { Job };
