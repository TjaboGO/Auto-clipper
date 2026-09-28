import fs from 'fs';
import path from 'path';
import type { TranscriptSegment } from './types';

/** Escape a filesystem path for use as an ffmpeg filtergraph option value. */
export function escapeFfmpegFilterPath(p: string): string {
  return p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function formatAssTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s - h * 3600 - m * 60;
  return `${h}:${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`;
}

function escapeAssText(text: string): string {
  // Curly braces start ASS override tags - strip them from spoken text so
  // a stray "{" in the transcript can't break the karaoke tags we insert.
  return text.replace(/\{/g, '(').replace(/\}/g, ')');
}

export interface AssStyleOptions {
  fontSize?: number;
  /** distance from the bottom edge, in px, on the 1080x1920 output canvas */
  marginV?: number;
}

/**
 * Build a TikTok/CapCut-style bold, centered, word-highlighted (karaoke)
 * .ass subtitle file for ONE output clip.
 *
 * `transcript` uses absolute source-video timestamps (as returned by
 * Gemini); `clipStart`/`clipEnd` are also absolute. Output event times are
 * shifted so 0 == clipStart, which is how ffmpeg's `ass` filter will see
 * time after the clip is trimmed out with `-ss clipStart`.
 *
 * Gemini gives us segment-level (not word-perfect) timestamps, so word
 * highlight timing is approximated by splitting each segment's duration
 * evenly across its words. That's a deliberate, documented simplification -
 * good enough for the "sweeping highlight" caption look, not forced-aligned
 * to the audio down to the millisecond.
 */
export function buildClipAss(
  transcript: TranscriptSegment[],
  clipStart: number,
  clipEnd: number,
  style: AssStyleOptions = {},
): string {
  const fontSize = style.fontSize ?? 72;
  const marginV = style.marginV ?? 220;

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,Arial Black,${fontSize},&H00FFFFFF,&H0000D7FF,&H00101010,&H00000000,1,0,0,0,100,100,0,0,1,6,0,2,60,60,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const relevant = transcript.filter((s) => s.end > clipStart && s.start < clipEnd);

  const lines = relevant
    .map((seg) => {
      const segStart = Math.max(seg.start, clipStart) - clipStart;
      const segEnd = Math.min(seg.end, clipEnd) - clipStart;
      const words = seg.text.trim().split(/\s+/).filter(Boolean);
      if (words.length === 0 || segEnd <= segStart) return '';

      const duration = Math.max(0.1, segEnd - segStart);
      const perWordCs = Math.max(5, Math.round((duration / words.length) * 100));
      const karaokeText = words.map((w) => `{\\k${perWordCs}}${escapeAssText(w)}`).join(' ');

      return `Dialogue: 0,${formatAssTime(segStart)},${formatAssTime(segEnd)},Caption,,0,0,0,,${karaokeText}`;
    })
    .filter(Boolean);

  return header + lines.join('\n') + '\n';
}

export function writeClipAss(
  transcript: TranscriptSegment[],
  clipStart: number,
  clipEnd: number,
  outPath: string,
  style?: AssStyleOptions,
): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buildClipAss(transcript, clipStart, clipEnd, style), 'utf-8');
}
