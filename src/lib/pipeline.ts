import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { jobStore } from './jobStore';
import { jobWorkDir, jobOutputDir } from './paths';
import { renderQueue } from './queue';
import { extractAudio, renderClip, generateThumbnail } from './ffmpeg';
import { probeDuration } from './probe';
import { transcribeAudio, findHighlights } from './gemini';
import { writeClipAss } from './captions';
import { downloadFromUrl } from './youtube';
import type { Job, JobStatus, RenderedClip } from './types';

function logStep(jobId: string, step: JobStatus, message: string): void {
  jobStore.update(jobId, { status: step });
  jobStore.appendProgress(jobId, { step, message, at: new Date().toISOString() });
}

/** Put a freshly-created job on the background render queue. */
export function enqueueJob(jobId: string): void {
  renderQueue.push(() => processJob(jobId));
}

/**
 * Full pipeline for one job: ingest -> transcribe -> pick highlights ->
 * render each clip (smart crop + burned captions). Every step updates the
 * job in jobStore so the frontend's polling can show live progress.
 */
export async function processJob(jobId: string): Promise<void> {
  const job = jobStore.get(jobId);
  if (!job) {
    console.error(`[pipeline] processJob called for unknown job ${jobId}`);
    return;
  }

  try {
    const workDir = jobWorkDir(jobId);
    const outDir = jobOutputDir(jobId);

    // 1. Ingest source video: either already-uploaded file, or a YouTube URL
    //    we need to fetch first with yt-dlp.
    let sourcePath = job.sourceVideoPath;
    if (job.source.type === 'youtube') {
      logStep(jobId, 'downloading', `Laddar ner videon från ${job.source.url} ...`);
      sourcePath = await downloadFromUrl(job.source.url, workDir);
      jobStore.update(jobId, { sourceVideoPath: sourcePath });
    }
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      throw new Error('Källvideon saknas eller kunde inte hämtas.');
    }

    const durationSec = await probeDuration(sourcePath);
    jobStore.update(jobId, { sourceDurationSec: durationSec });

    // 2. Extract audio and transcribe it with Gemini.
    logStep(jobId, 'transcribing', 'Transkriberar ljudet med Gemini ...');
    const audioPath = path.join(workDir, 'audio.mp3');
    await extractAudio(sourcePath, audioPath);
    const transcript = await transcribeAudio(audioPath);
    jobStore.update(jobId, { transcript });

    // 3. Ask Gemini to act as an editor and pick the best moments.
    logStep(jobId, 'analyzing', 'Hittar de bästa klippen ...');
    const suggestions = await findHighlights(transcript, {
      clipCount: job.clipCount,
      sourceDurationSec: durationSec,
    });
    jobStore.update(jobId, { suggestions });

    // 4. Render each clip: face-tracked vertical crop + burned-in captions.
    logStep(jobId, 'rendering', `Renderar ${suggestions.length} klipp ...`);
    const clips: RenderedClip[] = [];
    for (let i = 0; i < suggestions.length; i++) {
      const suggestion = suggestions[i];
      const index = i + 1;
      const filename = `clip_${index}.mp4`;
      const assPath = path.join(workDir, `clip_${index}.ass`);
      const outPath = path.join(outDir, filename);

      writeClipAss(transcript, suggestion.start, suggestion.end, assPath);
      await renderClip({
        sourcePath,
        start: suggestion.start,
        end: suggestion.end,
        assPath,
        outPath,
      });

      try {
        await generateThumbnail(outPath, path.join(outDir, `clip_${index}.jpg`));
      } catch (err) {
        console.warn(`[pipeline] thumbnail generation failed for ${filename}:`, err);
      }

      clips.push({
        ...suggestion,
        id: uuidv4(),
        filename,
        durationSec: suggestion.end - suggestion.start,
      });

      jobStore.update(jobId, { clips: [...clips] });
      jobStore.appendProgress(jobId, {
        step: 'rendering',
        message: `Klar: "${suggestion.title}" (${index}/${suggestions.length})`,
        at: new Date().toISOString(),
      });
    }

    jobStore.update(jobId, { status: 'done' });
    jobStore.appendProgress(jobId, {
      step: 'done',
      message: 'Klart! Alla klipp är redo att laddas ner.',
      at: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[pipeline] job ${jobId} failed:`, err);
    jobStore.update(jobId, { status: 'error', error: message });
    jobStore.appendProgress(jobId, { step: 'error', message, at: new Date().toISOString() });
  }
}

export function newJobId(): string {
  return uuidv4();
}

export type { Job };
