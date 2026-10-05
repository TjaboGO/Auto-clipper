import fs from 'fs';
import path from 'path';
import { config } from './config';
import { run } from './exec';
import { brandInfo, customFontPath, logoFile } from './brand';
import { buildClipAss, escapeFfmpegFilterPath } from './captions';
import { buildRenderGraph } from './renderGraph';
import { captionFont, isCustomFontId } from './edit/fonts';
import { logoRect, OUTPUT_SIZES, resolveLayout, type ResolvedLayout } from './edit/layout';
import {
  applyReframe,
  keptRanges,
  keyframesForRange,
  outputDuration,
  outputWords,
} from './edit/timeline';
import type { ClipEdit, ClipEditorData, SplitHalf } from './edit/types';

export interface RenderResult {
  layout: ResolvedLayout;
  /** Length of the finished clip, after the cuts. */
  duration: number;
  /** Why the layout isn't what was asked for, if it isn't. */
  note?: string;
}

/**
 * Render one clip as edited, in a single ffmpeg pass: read [start,end] of
 * the source, frame it (follow the speaker, split screen or the whole
 * frame) in the chosen format, cut out removed words and pauses, and burn
 * in the captions and title. The pipeline's first render goes through here
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
}): Promise<RenderResult> {
  const { sourcePath, data, edit, outPath, workDir, name } = opts;
  // Loads the brand kit, which also makes your own fonts known to the caption code.
  const brand = brandInfo();
  const out = OUTPUT_SIZES[edit.aspect];
  const { layout, note } = resolveLayout(edit.layout, edit.aspect, data.source, data.analysis);
  const kept = keptRanges(edit, data.words);
  if (kept.length === 0) throw new Error('Hela klippet är bortklippt, det finns inget kvar att rendera.');
  const duration = outputDuration(kept);
  const length = edit.end - edit.start;

  fs.mkdirSync(workDir, { recursive: true });
  const assPath = path.join(workDir, `${name}.ass`);
  fs.writeFileSync(
    assPath,
    buildClipAss({
      words: outputWords(edit, data.words, kept),
      clipLength: duration,
      captions: edit.captions,
      title: edit.title,
      out,
      layout,
      aspect: edit.aspect,
    }),
    'utf-8',
  );

  // Framing keyframes are source times; ffmpeg's t starts at 0 at `start`.
  const auto = data.analysis?.keyframes ?? [];
  const keyframes = keyframesForRange(applyReframe(auto, edit.reframe), edit.start, edit.end);
  let split: { top: SplitHalf; bottom: SplitHalf } | undefined;
  if (layout === 'split' && data.analysis?.split) {
    const onClip = (half: SplitHalf): SplitHalf => ({
      ...half,
      keyframes: keyframesForRange(half.keyframes, edit.start, edit.end),
    });
    const { top, bottom } = data.analysis.split;
    split = edit.splitSwap
      ? { top: onClip(bottom), bottom: onClip(top) }
      : { top: onClip(top), bottom: onClip(bottom) };
  }

  // One of your fonts: libass gets a folder with just that font, so no
  // font that comes with the app can have the same name.
  let fontsDir = config.fontsDir;
  const customFile = isCustomFontId(edit.captions.font) ? customFontPath(captionFont(edit.captions.font).file) : null;
  if (customFile) {
    fontsDir = path.join(/* turbopackIgnore: true */ workDir, `${name}-fonts`);
    fs.mkdirSync(fontsDir, { recursive: true });
    fs.copyFileSync(customFile, path.join(/* turbopackIgnore: true */ fontsDir, path.basename(customFile)));
  }
  const logo = edit.logo.enabled && brand.logo ? { rect: logoRect(out, brand.logo, edit.logo), opacity: edit.logo.opacity } : undefined;

  const { graph, maps } = buildRenderGraph({
    source: data.source,
    out,
    layout,
    keyframes,
    split,
    kept: kept.map((r) => ({ start: r.start - edit.start, end: r.end - edit.start })),
    length,
    hasAudio: data.source.hasAudio,
    captionsFilter:
      `ass=filename='${escapeFfmpegFilterPath(assPath)}'` +
      `:fontsdir='${escapeFfmpegFilterPath(fontsDir)}'`,
    logo,
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
      ...(logo ? ['-i', logoFile()] : []),
      '-filter_complex_script', graphPath,
      ...maps,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '21',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      outPath,
    ],
    {},
    Math.max(600, 20 * length) * 1000,
  );
  return { layout, duration, note };
}
