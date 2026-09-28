import { cropLeft, fitRect, singleCrop, splitCrop, type OutputSize, type ResolvedLayout } from './edit/layout';
import type { CropKeyframe, SourceInfo, SplitHalf, TimeRange } from './edit/types';

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
): string {
  const toPixelX = (cx: number): number => cropLeft(cx, cropWidth, sourceWidth);
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
  /** split: the two people's crops, keyframes on the clip's timeline. */
  split?: { top: SplitHalf; bottom: SplitHalf };
  /** The parts of the clip that are kept, on the clip's timeline. */
  kept: TimeRange[];
  /** How much of the source ffmpeg reads (end - start of the clip). */
  length: number;
  hasAudio: boolean;
  /** The ass=... filter that burns in the captions. */
  captionsFilter: string;
}

/** The video part of the graph up to the finished frame: crop, split screen or fit. */
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
  if (layout === 'split' && input.split) {
    const half = (h: SplitHalf): string => {
      const box = splitCrop(source, out, h);
      const x = keyframesToCropXExpr(h.keyframes, box.w, source.width);
      return `crop=w=${box.w}:h=${box.h}:x='${x}':y=${box.y},scale=${out.w}:${out.h / 2}`;
    };
    return (
      `[0:v]split=2[first][second];` +
      `[first]${half(input.split.top)}[top];[second]${half(input.split.bottom)}[bottom];` +
      `[top][bottom]vstack=inputs=2`
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
  let graph = `${video},${input.captionsFilter}[vout]`;
  const maps = ['-map', '[vout]'];

  if (!input.hasAudio) return { graph, maps };
  if (whole) {
    maps.push('-map', '0:a:0');
    return { graph, maps };
  }

  const pieces = kept.map((r, i) => {
    const length = r.end - r.start;
    const fade = num(Math.min(0.01, length / 4));
    return (
      `atrim=start=${num(r.start)}:end=${num(r.end)},asetpts=PTS-STARTPTS,` +
      `afade=t=in:st=0:d=${fade},afade=t=out:st=${num(length - Math.min(0.01, length / 4))}:d=${fade}[b${i}]`
    );
  });
  if (kept.length === 1) {
    graph += `;[0:a:0]${pieces[0]}`;
    maps.push('-map', '[b0]');
    return { graph, maps };
  }
  graph +=
    `;[0:a:0]asplit=${kept.length}${kept.map((_, i) => `[a${i}]`).join('')}` +
    pieces.map((piece, i) => `;[a${i}]${piece}`).join('') +
    `;${kept.map((_, i) => `[b${i}]`).join('')}concat=n=${kept.length}:v=0:a=1[aout]`;
  maps.push('-map', '[aout]');
  return { graph, maps };
}
