import { cropLeft, fitRect, singleCrop, type OutputSize, type Panel, type ResolvedLayout } from './edit/layout';
import { EMOJI_POP, EMOJI_RISE } from './edit/emoji';
import { FLASH, planGlides, ZOOM_CENTER, zoomAmountExpr, type ZoomPlan } from './edit/zoom';
import type { CropKeyframe, SourceInfo, TimeRange } from './edit/types';

function num(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

function even(n: number): number {
  return Math.max(2, Math.floor(n / 2) * 2);
}

/**
 * Turn crop keyframes (normalized center-x) into an ffmpeg `crop` x=
 * expression in pixels. Between two keyframes the crop either holds and
 * then jumps (next keyframe is a cut) or pans linearly (next keyframe is a
 * pan). `t` is evaluated by ffmpeg against the clip's own timeline (0 = clip
 * start), matching the keyframes.
 */
export function keyframesToCropXExpr(
  keyframes: CropKeyframe[],
  cropWidth: number,
  sourceWidth: number,
  bounds?: { min: number; max: number },
): string {
  const toPixelX = (cx: number): number => cropLeft(cx, cropWidth, sourceWidth, bounds?.min, bounds?.max);
  if (keyframes.length === 1) {
    return String(toPixelX(keyframes[0].cx));
  }

  // Nest from the last keyframe backwards: if(t < nextTime, segment, rest).
  // NOTE: commas here are literal - the caller wraps this whole expression
  // in single quotes (x='<expr>') before handing it to ffmpeg, and inside
  // single-quoted ffmpeg filtergraph values commas are NOT special and must
  // NOT be backslash-escaped (backslash isn't a recognized escape there
  // either, so a `\,` would be passed straight through to libavutil's eval
  // parser as a literal backslash and fail to parse).
  let expr = String(toPixelX(keyframes[keyframes.length - 1].cx));
  for (let i = keyframes.length - 2; i >= 0; i--) {
    const from = keyframes[i];
    const to = keyframes[i + 1];
    const x0 = toPixelX(from.cx);
    const x1 = toPixelX(to.cx);
    const dt = to.t - from.t;
    let segment = String(x0);
    if (!to.cut && x1 !== x0 && dt > 0) {
      const dx = x1 - x0;
      segment = `${x0}${dx < 0 ? '-' : '+'}${Math.abs(dx)}*(t-${num(from.t)})/${num(dt)}`;
    }
    expr = `if(lt(t,${num(to.t)}),${segment},${expr})`;
  }
  return expr;
}

export interface RenderGraphInput {
  source: SourceInfo;
  out: OutputSize;
  layout: ResolvedLayout;
  /** single: crop keyframes on the clip's timeline (0 = clip start). */
  keyframes: CropKeyframe[];
  /** split, facecam, screen, group: the parts of the frame, keyframes on the clip's timeline. */
  panels?: Panel[] | null;
  /** The parts of the clip that are kept, on the clip's timeline. */
  kept: TimeRange[];
  /** How much of the source ffmpeg reads (end - start of the clip). */
  length: number;
  hasAudio: boolean;
  /** The ass=... filter that burns in the captions. */
  captionsFilter: string;
  /** Your logo (ffmpeg input 1), placed under the captions. */
  logo?: { rect: { x: number; y: number; w: number; h: number }; opacity: number };
  /**
   * Emojis over the captions: each a looped picture input (`input`), shown
   * from `start` to `end` (clip timeline) at `rect`, popping in.
   */
  emojis?: { input: number; rect: { x: number; y: number; size: number }; start: number; end: number }[];
  /**
   * Zooms on the finished clip's timeline: jumps are a scaled copy laid
   * over the frame, glides go through zoompan at `rate` (the frame rate,
   * as ffmpeg's -r takes it).
   */
  zoom?: { plan: ZoomPlan; rate?: string };
  /** White flashes at the cuts (finished clip's timeline). */
  flash?: TimeRange[];
  /** Background music: an audio input looped and cut to the clip's length, and its level. */
  music?: { input: number; volume: number };
  /** Stock video over parts of the clip: each a video input, filling the frame from `start` to `end`. */
  broll?: { input: number; start: number; end: number }[];
  /** A bar that fills up over the clip, at `rect`, under the captions. */
  progress?: { color: string; rect: { y: number; h: number } };
}

/** The video part of the graph up to the finished frame: crop, parts stacked together, or fit. */
function framingChain(input: RenderGraphInput): string {
  const { source, out, layout } = input;
  if (layout === 'fit') {
    // The whole frame, over a blurred and darkened copy of itself. The blur
    // runs on a tiny version, which is fast and looks just as soft.
    const rect = fitRect(source, out);
    const bw = even(out.w / 10);
    const bh = even(out.h / 10);
    return (
      `[0:v]split=2[bgsrc][fgsrc];` +
      `[bgsrc]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},` +
      `boxblur=4:2,scale=${out.w}:${out.h},lutyuv=y=val*0.7[bg];` +
      `[fgsrc]scale=${rect.w}:${rect.h}[fg];` +
      `[bg][fg]overlay=${rect.x}:${rect.y}`
    );
  }
  if (input.panels && input.panels.length >= 2) {
    // Every part crops its own copy of the picture; xstack puts them
    // together at their places in the frame.
    const panels = input.panels;
    const parts = panels.map((p, i) => {
      const x = keyframesToCropXExpr(p.keyframes, p.w, source.width, { min: p.minX, max: p.maxX });
      return `[in${i}]crop=w=${p.w}:h=${p.h}:x='${x}':y=${p.y},scale=${p.dest.w}:${p.dest.h},setsar=1[part${i}]`;
    });
    return (
      `[0:v]split=${panels.length}${panels.map((_, i) => `[in${i}]`).join('')};` +
      parts.join(';') +
      `;${panels.map((_, i) => `[part${i}]`).join('')}xstack=inputs=${panels.length}:layout=` +
      panels.map((p) => `${p.dest.x}_${p.dest.y}`).join('|')
    );
  }
  const box = singleCrop(source, out);
  const x = box.pans ? `'${keyframesToCropXExpr(input.keyframes, box.w, source.width)}'` : '0';
  return `[0:v]crop=w=${box.w}:h=${box.h}:x=${x}:y=${box.y},scale=${out.w}:${out.h}`;
}

/**
 * The whole ffmpeg filtergraph for one clip: framing, the cuts (removed
 * words and pauses), captions and the matching audio. Returns the graph
 * and the -map arguments for its outputs.
 *
 * Cuts: the video keeps only frames inside the kept parts (select) and
 * shifts them to close the gaps (setpts), which works in one pass without
 * buffering. The audio is trimmed into the same parts, each with a 10 ms
 * fade at both ends so the joins don't click, and joined back together.
 */
export function buildRenderGraph(input: RenderGraphInput): { graph: string; maps: string[] } {
  const kept = input.kept;
  const whole =
    kept.length === 1 && kept[0].start <= 0.001 && kept[0].end >= input.length - 0.001;

  let video = `${framingChain(input)},setsar=1`;
  if (!whole) {
    const inside = kept.map((r) => `between(t,${num(r.start)},${num(r.end)})`).join('+');
    // Time removed before each kept part: everything before the first one,
    // plus the gap in front of every later one.
    const offset = [
      num(kept[0].start),
      ...kept.slice(1).map((r, i) => `gte(T,${num(r.start)})*${num(r.start - kept[i].end)}`),
    ].join('+');
    video += `,select='${inside}',setpts='(T-(${offset}))/TB'`;
  }
  const plan = input.zoom?.plan;
  if (plan && plan.factor > 1 && plan.spans.length > 0) {
    const { w, h } = input.out;
    if (planGlides(plan)) {
      // Glides: zoompan with the zoom worked out per frame. It counts
      // frames, so the frame rate is made steady first.
      const rate = input.zoom?.rate ?? '30';
      video +=
        `,fps=${rate},zoompan=z='1+${num(plan.factor - 1)}*(${zoomAmountExpr(plan)})'` +
        `:x='(iw-iw/zoom)*${ZOOM_CENTER.x}':y='(ih-ih/zoom)*${ZOOM_CENTER.y}':d=1:s=${w}x${h}:fps=${rate},setsar=1` +
        // The steady rate pads up to where the source would have ended: stop at the clip's end.
        `,trim=end=${num(outputLength(input))}`;
    } else {
      // Jumps: a copy of the finished frame, scaled up and cut back to size
      // around ZOOM_CENTER, laid over the frame while a zoom lasts.
      const zw = even(w * plan.factor);
      const zh = even(h * plan.factor);
      const x = Math.round((zw - w) * ZOOM_CENTER.x);
      const y = Math.round((zh - h) * ZOOM_CENTER.y);
      const when = plan.spans.map((s) => `between(t,${num(s.start)},${num(s.end)})`).join('+');
      video +=
        `,split=2[wide][close];[close]scale=${zw}:${zh},crop=${w}:${h}:${x}:${y}[closer];` +
        `[wide][closer]overlay=0:0:enable='${when}'`;
    }
  }
  if (input.flash?.length) {
    const when = input.flash.map((f) => `between(t,${num(f.start)},${num(f.end)})`).join('+');
    video += `,drawbox=x=0:y=0:w=iw:h=ih:color=white@${num(FLASH.alpha)}:t=fill:enable='${when}'`;
  }
  // The progress bar goes over everything but the captions.
  const finish = (label: string) => topLayers(label, input, outputLength(input), '');
  let graph = input.progress ? `${video}[vbase]${finish('vbase')}` : `${video},${input.captionsFilter}[vout]`;
  if (input.emojis?.length || input.broll?.length) {
    // Layers one after the other - B-roll, logo, emojis - then the captions on top.
    graph = `${video}[v0]`;
    let current = 'v0';
    const { w, h } = input.out;
    (input.broll ?? []).forEach((b, i) => {
      graph +=
        `;[${b.input}:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,` +
        `setpts=PTS-STARTPTS+${num(b.start)}/TB[br${i}]` +
        `;[${current}][br${i}]overlay=0:0:eof_action=pass:enable='between(t,${num(b.start)},${num(b.end)})'[vb${i}]`;
      current = `vb${i}`;
    });
    const layers = logoAndEmojis(current, input, '');
    graph += layers.graph + finish(layers.label);
  } else if (input.logo) {
    const { rect, opacity } = input.logo;
    graph = input.progress
      ? `${video}[base];${logoFilter(rect, opacity)};[base][logo]overlay=${rect.x}:${rect.y}[vl]${finish('vl')}`
      : `${video}[base];${logoFilter(rect, opacity)};[base][logo]overlay=${rect.x}:${rect.y},${input.captionsFilter}[vout]`;
  }
  const maps = ['-map', '[vout]'];
  const speech = speechAudio(input, whole);
  graph += speech.graph;
  if (!input.music) {
    if (speech.label) maps.push('-map', speech.label);
    return { graph, maps };
  }

  // Background music (its input is already looped and cut to the clip's
  // length): faded in and out, and pushed down while someone talks.
  const { music } = input;
  const length = outputLength(input);
  const fadeOut = Math.min(1.5, length / 3);
  graph +=
    `;[${music.input}:a]volume=${num(music.volume)},afade=t=in:st=0:d=${num(Math.min(1, length / 4))},` +
    `afade=t=out:st=${num(Math.max(0, length - fadeOut))}:d=${num(fadeOut)}[music]`;
  if (!speech.label) {
    maps.push('-map', '[music]');
    return { graph, maps };
  }
  graph +=
    `;${speech.label}asplit=2[voice][key]` +
    `;[music][key]sidechaincompress=threshold=0.02:ratio=8:attack=15:release=350[ducked]` +
    `;[voice][ducked]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[mixed]`;
  maps.push('-map', '[mixed]');
  return { graph, maps };
}

/** The logo (input 1), scaled and see-through as set, labelled [logo]. */
function logoFilter(rect: { w: number; h: number }, opacity: number): string {
  return `[1:v]scale=${rect.w}:${rect.h},format=rgba,colorchannelmixer=aa=${num(opacity)}[logo]`;
}

/**
 * The logo and then the emojis laid over [label]. `overlayOptions` is
 * added to each overlay (":format=auto" keeps a see-through picture
 * see-through). Returns the graph (starting with ";") and the new label.
 */
function logoAndEmojis(
  label: string,
  input: Pick<RenderGraphInput, 'logo' | 'emojis'>,
  overlayOptions: string,
): { graph: string; label: string } {
  let graph = '';
  let current = label;
  if (input.logo) {
    const { rect, opacity } = input.logo;
    graph += `;${logoFilter(rect, opacity)};[${current}][logo]overlay=${rect.x}:${rect.y}${overlayOptions}[vl]`;
    current = 'vl';
  }
  (input.emojis ?? []).forEach((e, i) => {
    const rise = Math.round(EMOJI_RISE * e.rect.size);
    graph +=
      `;[${e.input}:v]format=rgba,scale=${e.rect.size}:${e.rect.size},` +
      `fade=t=in:st=${num(e.start)}:d=${num(EMOJI_POP)}:alpha=1[em${i}]` +
      `;[${current}][em${i}]overlay=x=${e.rect.x}:y='${e.rect.y}+${rise}*max(0,1-(t-${num(e.start)})/${num(EMOJI_POP)})'` +
      `:enable='between(t,${num(e.start)},${num(e.end)})'${overlayOptions}[ve${i}]`;
    current = `ve${i}`;
  });
  return { graph, label: current };
}

/**
 * The progress bar (if any) over [label], then the captions: the graph
 * part from [label] to [vout], starting with ";".
 */
function topLayers(
  label: string,
  input: Pick<RenderGraphInput, 'progress' | 'captionsFilter' | 'out'>,
  length: number,
  overlayOptions: string,
  captionsOptions = '',
): string {
  let graph = '';
  let current = label;
  if (input.progress) {
    const { color, rect } = input.progress;
    const d = Math.max(0.1, length);
    graph +=
      `;color=c=0x${color.replace('#', '')}:s=${input.out.w}x${rect.h}:r=30:d=${num(d + 1)}[pbar]` +
      // shortest=1: the strip runs a little past the clip, the clip decides when it ends.
      `;[${current}][pbar]overlay=x='-w+W*min(1,t/${num(d)})':y=${rect.y}:eof_action=repeat:shortest=1${overlayOptions}[vp]`;
    current = 'vp';
  }
  return `${graph};[${current}]${input.captionsFilter}${captionsOptions}[vout]`;
}

/**
 * The clip's graphics on their own, for the project export: captions,
 * title, logo, emojis and the progress bar over a see-through frame
 * (input 0, a transparent color source), so an editing program can lay
 * them over the video.
 */
export function buildGraphicsGraph(
  input: Pick<RenderGraphInput, 'logo' | 'emojis' | 'captionsFilter' | 'progress' | 'out'>,
  length: number,
): string {
  const layers = logoAndEmojis('0:v', input, ':format=auto');
  const graph = layers.graph + topLayers(layers.label, input, length, ':format=auto', ':alpha=1,format=yuva444p10le');
  return graph.replace(/^;/, '');
}

/** Length of the finished clip (the kept parts together). */
function outputLength(input: RenderGraphInput): number {
  return input.kept.reduce((sum, r) => sum + r.end - r.start, 0);
}

/**
 * The clip's own sound after the cuts: the label to map or mix (null
 * without sound), and the graph part that makes it. Each kept part gets a
 * 10 ms fade at both ends so the joins don't click.
 */
function speechAudio(input: RenderGraphInput, whole: boolean): { graph: string; label: string | null } {
  const kept = input.kept;
  if (!input.hasAudio) return { graph: '', label: null };
  if (whole) return input.music ? { graph: ';[0:a:0]anull[speech]', label: '[speech]' } : { graph: '', label: '0:a:0' };
  const pieces = kept.map((r, i) => {
    const length = r.end - r.start;
    const fade = num(Math.min(0.01, length / 4));
    return (
      `atrim=start=${num(r.start)}:end=${num(r.end)},asetpts=PTS-STARTPTS,` +
      `afade=t=in:st=0:d=${fade},afade=t=out:st=${num(length - Math.min(0.01, length / 4))}:d=${fade}[b${i}]`
    );
  });
  if (kept.length === 1) return { graph: `;[0:a:0]${pieces[0]}`, label: '[b0]' };
  return {
    graph:
      `;[0:a:0]asplit=${kept.length}${kept.map((_, i) => `[a${i}]`).join('')}` +
      pieces.map((piece, i) => `;[a${i}]${piece}`).join('') +
      `;${kept.map((_, i) => `[b${i}]`).join('')}concat=n=${kept.length}:v=0:a=1[aout]`,
    label: '[aout]',
  };
}

