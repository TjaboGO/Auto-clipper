import fs from 'fs';
import path from 'path';
import { config } from './config';
import { run } from './exec';
import { brandInfo, customFontPath, logoFile, musicTrack } from './brand';
import { buildClipAss, escapeFfmpegFilterPath } from './captions';
import { buildRenderGraph, type RenderGraphInput } from './renderGraph';
import { captionFont, isCustomFontId } from './edit/fonts';
import { captionMetrics, captionPages } from './edit/captionLayout';
import { clipEmojiShows, emojiFile, emojiRect } from './edit/emoji';
import { translatedWords } from './edit/translation';
import { flashWindows, planGlides, zoomPlan } from './edit/zoom';
import { ffmpegRate, nleRate } from './nle';
import { probeFrameRate } from './probe';
import { brollShows } from './edit/broll';
import { brollPath, downloadVideo } from './pexels';
import { defaultCaptionPosition, framePanels, logoRect, OUTPUT_SIZES, progressRect, resolveLayout, type Panel, type ResolvedLayout } from './edit/layout';
import {
  applyReframe,
  keptRanges,
  keyframesForRange,
  outputDuration,
  outputWords,
  type OutputWord,
} from './edit/timeline';
import type { ClipEdit, ClipEditorData, TimeRange } from './edit/types';

export interface RenderResult {
  layout: ResolvedLayout;
  /** Length of the finished clip, after the cuts. */
  duration: number;
  /** Why the layout isn't what was asked for, if it isn't. */
  note?: string;
}

/** What goes over the framed picture: captions, title, logo and emojis. */
export interface ClipGraphics {
  /** ffmpeg input arguments, in order from input 1: the logo, then the emojis. */
  inputs: string[];
  /** How many inputs that is. */
  inputCount: number;
  logo?: RenderGraphInput['logo'];
  emojis: NonNullable<RenderGraphInput['emojis']>;
  /** The ass=... filter for the captions and title. */
  captionsFilter: string;
  /** The spoken words on the finished clip's timeline. */
  spoken: OutputWord[];
  /** The progress bar, if it's on. */
  progress?: RenderGraphInput['progress'];
  /** Whether anything shows at all (captions, a title, the logo, an emoji or the progress bar). */
  visible: boolean;
}

/**
 * Captions, title, logo and emojis for a clip, the same way for the render
 * and for the project export: writes the .ass file (and a font folder for
 * one of your fonts) to `workDir`. `loopFor`: how long each emoji picture
 * input lasts.
 */
export function clipGraphics(opts: {
  data: ClipEditorData;
  edit: ClipEdit;
  kept: TimeRange[];
  layout: ResolvedLayout;
  panels: Panel[] | null;
  workDir: string;
  name: string;
  loopFor: number;
}): ClipGraphics {
  const { data, edit, kept, layout, panels, workDir, name } = opts;
  // Loads the brand kit, which also makes your own fonts known to the caption code.
  const brand = brandInfo();
  const out = OUTPUT_SIZES[edit.aspect];
  const duration = outputDuration(kept);

  // The captions show the spoken words, or their translation.
  const spoken = outputWords(edit, data.words, kept);
  const words = translatedWords(spoken, edit.translation ?? null);
  const captionY = defaultCaptionPosition(layout, edit.aspect, panels);

  fs.mkdirSync(workDir, { recursive: true });
  const assPath = path.join(workDir, `${name}.ass`);
  fs.writeFileSync(
    assPath,
    buildClipAss({ words, clipLength: duration, captions: edit.captions, title: edit.title, out, captionY, aspect: edit.aspect }),
    'utf-8',
  );

  const logo = edit.logo.enabled && brand.logo ? { rect: logoRect(out, brand.logo, edit.logo), opacity: edit.logo.opacity } : undefined;
  const inputs = logo ? ['-i', logoFile()] : [];
  // Emojis over the captions: one looped picture input each, after the logo.
  const metrics = captionMetrics(edit.captions, out, captionY, edit.aspect);
  const pages = captionPages(words, duration, { maxWords: metrics.maxWords, maxChars: metrics.maxChars, uppercase: edit.captions.uppercase });
  let nextInput = logo ? 2 : 1;
  const emojis = clipEmojiShows(edit, spoken, pages, duration).flatMap((show) => {
    const file = path.join(config.emojiDir, emojiFile(show.emoji));
    if (!fs.existsSync(file)) return [];
    inputs.push('-loop', '1', '-t', String(Math.max(0.2, opts.loopFor)), '-i', file);
    return [{ input: nextInput++, rect: emojiRect(metrics), start: show.start, end: show.end }];
  });

  // One of your fonts: libass gets a folder with just that font, so no
  // font that comes with the app can have the same name.
  let fontsDir = config.fontsDir;
  const customFile = isCustomFontId(edit.captions.font) ? customFontPath(captionFont(edit.captions.font).file) : null;
  if (customFile) {
    fontsDir = path.join(/* turbopackIgnore: true */ workDir, `${name}-fonts`);
    fs.mkdirSync(fontsDir, { recursive: true });
    fs.copyFileSync(customFile, path.join(/* turbopackIgnore: true */ fontsDir, path.basename(customFile)));
  }
  const title = edit.title.enabled && edit.title.text.trim() !== '';
  const progress = edit.progress?.enabled ? { color: edit.progress.color, rect: progressRect(out, edit.progress.position) } : undefined;
  return {
    inputs,
    inputCount: nextInput - 1,
    logo,
    emojis,
    captionsFilter: `ass=filename='${escapeFfmpegFilterPath(assPath)}':fontsdir='${escapeFfmpegFilterPath(fontsDir)}'`,
    spoken,
    progress,
    visible: (edit.captions.enabled && words.length > 0) || title || !!logo || emojis.length > 0 || !!progress,
  };
}

/**
 * Render one clip as edited, in a single ffmpeg pass: read [start,end] of
 * the source, frame it (follow the speaker, split screen, facecam, screen,
 * group or the whole frame) in the chosen format, cut out removed words
 * and pauses, and burn in the captions and title. The pipeline's first render goes through here
 * too, so a clip opened in the editor and rendered unchanged comes out the
 * same.
 */
export async function renderClipEdit(opts: {
  sourcePath: string;
  data: ClipEditorData;
  edit: ClipEdit;
  outPath: string;
  workDir: string;
  /** Base name for the scratch files (.ass, filtergraph). */
  name: string;
  /**
   * For the project export: a constant frame rate (ffmpeg -r value), a
   * better quality and two sound channels.
   */
  master?: { rate: string };
}): Promise<RenderResult> {
  const { sourcePath, data, edit, outPath, workDir, name } = opts;
  const out = OUTPUT_SIZES[edit.aspect];
  const { layout, note } = resolveLayout(edit.layout, edit.aspect, data.source, data.analysis);
  const kept = keptRanges(edit, data.words);
  if (kept.length === 0) throw new Error('Hela klippet är bortklippt, det finns inget kvar att rendera.');
  const duration = outputDuration(kept);
  const length = edit.end - edit.start;
  const panels = framePanels({
    layout,
    source: data.source,
    out,
    analysis: data.analysis,
    swap: edit.splitSwap,
    panelSize: edit.panelSize,
  });

  const graphics = clipGraphics({ data, edit, kept, layout, panels, workDir, name, loopFor: length });
  const { spoken, logo, emojis } = graphics;
  let nextInput = 1 + graphics.inputCount;
  // Stock video: each one looped (if it's short) and cut to its time on screen.
  const brollInputs: string[] = [];
  const shows = brollShows(edit, spoken, duration);
  // A clip saved on another machine (or before a cleanup) fetches its stock video again.
  await Promise.all(shows.map((show) => downloadVideo(show.video).catch((err) => console.warn('[render] B-roll missing:', err))));
  const broll = shows.flatMap((show) => {
    const file = brollPath(show.video.file);
    if (!file || !fs.existsSync(file)) return [];
    brollInputs.push('-stream_loop', '-1', '-t', String(show.end - show.start), '-i', file);
    return [{ input: nextInput++, start: show.start, end: show.end }];
  });
  // Background music: looped and cut to the finished clip's length.
  const track = edit.music ? musicTrack(edit.music.track) : null;
  const musicInputs = track ? ['-stream_loop', '-1', '-t', String(Math.max(0.2, duration)), '-i', track.path] : [];
  const music = track && edit.music ? { input: nextInput++, volume: edit.music.volume } : undefined;

  // Framing keyframes are source times; ffmpeg's t starts at 0 at `start`.
  const auto = data.analysis?.keyframes ?? [];
  const keyframes = keyframesForRange(applyReframe(auto, edit.reframe), edit.start, edit.end);
  // The parts of a split screen, facecam, screen or group layout, on the clip's timeline.
  const parts = panels?.map((p) => ({ ...p, keyframes: keyframesForRange(p.keyframes, edit.start, edit.end) }));

  // Zooms (and "Zooma varannan") only where there's one picture to zoom into.
  const plan = layout === 'single' ? zoomPlan(edit, spoken, kept, duration) : null;
  const { graph, maps } = buildRenderGraph({
    source: data.source,
    out,
    layout,
    keyframes,
    panels: parts,
    kept: kept.map((r) => ({ start: r.start - edit.start, end: r.end - edit.start })),
    length,
    hasAudio: data.source.hasAudio,
    captionsFilter: graphics.captionsFilter,
    logo,
    emojis,
    broll,
    music,
    progress: graphics.progress,
    zoom: plan ? { plan, rate: planGlides(plan) ? ffmpegRate(nleRate(await probeFrameRate(sourcePath))) : undefined } : undefined,
    flash: edit.transition === 'flash' ? flashWindows(kept) : undefined,
  });
  // A clip with many cuts has a long graph: pass it as a file, not an argument.
  const graphPath = path.join(workDir, `${name}.filtergraph`);
  fs.writeFileSync(graphPath, graph, 'utf-8');

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await run(
    'ffmpeg',
    [
      '-y',
      '-ss', String(edit.start),
      '-t', String(Math.max(0.2, length)),
      '-i', sourcePath,
      ...graphics.inputs,
      ...brollInputs,
      ...musicInputs,
      '-filter_complex_script', graphPath,
      ...maps,
      ...(opts.master ? ['-r', opts.master.rate] : []),
      '-c:v', 'libx264',
      '-preset', opts.master ? 'fast' : 'veryfast',
      '-crf', opts.master ? '17' : '21',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', opts.master ? '192k' : '128k',
      ...(opts.master ? ['-ac', '2', '-ar', '48000'] : []),
      '-movflags', '+faststart',
      outPath,
    ],
    {},
    Math.max(600, 20 * length) * 1000,
  );
  return { layout, duration, note };
}
