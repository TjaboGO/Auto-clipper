// Getting the clips out: subtitle files per clip, and one ZIP with every
// clip, its subtitles and a text file with the titles, captions and
// hashtags to post with.
import fs from 'fs';
import path from 'path';
import { readClipEdit, readEditorData, readRenderedEdit } from './editor';
import { jobOutputDir } from './paths';
import { buildSrt, buildVtt, subtitleCues } from './edit/subtitles';
import { captionWords, keptRanges, outputDuration } from './edit/timeline';
import { captionLanguage } from './edit/translation';
import { safeFileName, type ZipEntry } from './zip';
import type { Job, RenderedClip } from './types';

export type SubtitleFormat = 'srt' | 'vtt';

/** The clip's subtitles, matching its current video. Null without editor data (very old jobs). */
export function clipSubtitles(jobId: string, clipId: string, format: SubtitleFormat): string | null {
  const data = readEditorData(jobId, clipId);
  const edit = readRenderedEdit(jobId, clipId) ?? readClipEdit(jobId, clipId);
  if (!data || !edit) return null;
  const kept = keptRanges(edit, data.words);
  if (kept.length === 0) return null;
  const cues = subtitleCues(captionWords(edit, data.words, kept), outputDuration(kept));
  return format === 'vtt' ? buildVtt(cues) : buildSrt(cues);
}

/** "01 Title": the clip's number in the job and its title, as a file name. */
export function clipFileBase(clip: RenderedClip, index: number): string {
  return `${String(index + 1).padStart(2, '0')} ${safeFileName(clip.title)}`;
}

function formatSeconds(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The text file in the ZIP: what to post with each clip. */
export function clipsSummary(job: Job): string {
  const title = job.source.type === 'youtube' ? job.source.title || job.source.url : job.source.originalName;
  const lines = [`Klipp från: ${title}`, ''];
  (job.clips ?? []).forEach((clip, i) => {
    const translation = readRenderedEdit(job.id, clip.id)?.translation;
    const language = captionLanguage(translation?.lang);
    lines.push(
      `${clipFileBase(clip, i)}`,
      `  Längd: ${formatSeconds(clip.durationSec)} (från ${formatSeconds(clip.start)} i videon)`,
      `  Viralitet: ${clip.viralityScore}/100`,
      ...(language ? [`  Texter på: ${language.label.toLowerCase()}`] : []),
      `  Bildtext: ${clip.caption}`,
      `  Hashtags: ${clip.hashtags.map((h) => `#${h.replace(/^#/, '')}`).join(' ')}`,
      `  Varför: ${clip.reason}`,
      '',
    );
  });
  return lines.join('\n');
}

/** Everything that goes in the job's ZIP. Clips whose video is missing are left out. */
export function jobZipEntries(job: Job, opts: { subtitles: boolean }): ZipEntry[] {
  const outDir = jobOutputDir(job.id);
  const entries: ZipEntry[] = [];
  (job.clips ?? []).forEach((clip, i) => {
    const video = path.join(outDir, path.basename(clip.filename));
    if (!fs.existsSync(video)) return;
    const base = clipFileBase(clip, i);
    entries.push({ name: `${base}.mp4`, path: video });
    if (opts.subtitles) {
      const srt = clipSubtitles(job.id, clip.id, 'srt');
      if (srt) entries.push({ name: `${base}.srt`, data: Buffer.from(srt, 'utf8') });
    }
  });
  entries.push({ name: 'klipp.txt', data: Buffer.from(clipsSummary(job), 'utf8') });
  return entries;
}
