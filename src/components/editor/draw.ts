// Canvas drawing for the editor's live preview. It mirrors the real render:
// the same crop geometry as the ffmpeg graph (renderGraph.ts) and the same
// caption pages, sizes and colours as the .ass file (captions.ts).
import { pageScale, wordColor, type CaptionMetrics, type CaptionPage, type TitleMetrics } from '@/lib/edit/captionLayout';
import { cssFontFamily, type CaptionFont } from '@/lib/edit/fonts';
import { cropLeft, fitRect, singleCrop, splitCrop, type OutputSize, type ResolvedLayout } from '@/lib/edit/layout';
import { cxAt } from '@/lib/edit/timeline';
import type { CaptionSettings, CropKeyframe, SourceInfo, SplitHalf } from '@/lib/edit/types';

export interface FrameSpec {
  source: SourceInfo;
  out: OutputSize;
  layout: ResolvedLayout;
  /** Crop keyframes for the single layout, source times. */
  keyframes: CropKeyframe[];
  split: { top: SplitHalf; bottom: SplitHalf } | null;
}

let blurCanvas: HTMLCanvasElement | null = null;

/** Draw the framed video at source time `t`, filling the canvas (which has the output's shape). */
export function drawFrame(ctx: CanvasRenderingContext2D, video: HTMLVideoElement, spec: FrameSpec, t: number): void {
  const { width: W, height: H } = ctx.canvas;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  if (!video.videoWidth) return;
  // The preview video is a smaller copy of the source.
  const ps = video.videoWidth / spec.source.width;

  if (spec.layout === 'fit') {
    // Blurred background: draw tiny, then scale up with smoothing.
    const bw = 24;
    const bh = Math.max(2, Math.round((bw * spec.out.h) / spec.out.w));
    blurCanvas ??= document.createElement('canvas');
    blurCanvas.width = bw;
    blurCanvas.height = bh;
    const b = blurCanvas.getContext('2d');
    if (b) {
      const cover = Math.max(bw / video.videoWidth, bh / video.videoHeight);
      const sw = bw / cover;
      const sh = bh / cover;
      b.drawImage(video, (video.videoWidth - sw) / 2, (video.videoHeight - sh) / 2, sw, sh, 0, 0, bw, bh);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(blurCanvas, 0, 0, W, H);
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.fillRect(0, 0, W, H);
    }
    const r = fitRect(spec.source, spec.out);
    const k = W / spec.out.w;
    ctx.drawImage(video, 0, 0, video.videoWidth, video.videoHeight, r.x * k, r.y * k, r.w * k, r.h * k);
    return;
  }

  if (spec.layout === 'split' && spec.split) {
    [spec.split.top, spec.split.bottom].forEach((half, i) => {
      const box = splitCrop(spec.source, spec.out, half);
      const x = cropLeft(cxAt(half.keyframes, t), box.w, spec.source.width);
      ctx.drawImage(video, x * ps, box.y * ps, box.w * ps, box.h * ps, 0, (i * H) / 2, W, H / 2);
    });
    return;
  }

  const box = singleCrop(spec.source, spec.out);
  const x = box.pans ? cropLeft(cxAt(spec.keyframes, t), box.w, spec.source.width) : 0;
  ctx.drawImage(video, x * ps, box.y * ps, box.w * ps, box.h * ps, 0, 0, W, H);
}

/** Manual framing: the whole source frame with the crop window on it. */
export function drawCropView(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  spec: FrameSpec,
  cx: number,
): void {
  const { width: W, height: H } = ctx.canvas;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  if (!video.videoWidth) return;
  ctx.drawImage(video, 0, 0, W, H);
  const box = singleCrop(spec.source, spec.out);
  const k = W / spec.source.width;
  const x = cropLeft(cx, box.w, spec.source.width) * k;
  const w = box.w * k;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(0, 0, x, H);
  ctx.fillRect(x + w, 0, W - x - w, H);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = Math.max(2, W / 400);
  ctx.strokeRect(x + 1, 1, w - 2, H - 2);
}

/** The caption page on screen at clip time `o`, and which of its words is being said. */
export function activeCaption(
  pages: CaptionPage[],
  o: number,
  settings: CaptionSettings,
): { page: CaptionPage; index: number } | null {
  for (const page of pages) {
    if (settings.preset === 'clean') {
      if (o >= page[0].start && o < page[page.length - 1].until) return { page, index: -1 };
      continue;
    }
    for (let i = 0; i < page.length; i++) {
      if (o >= page[i].start && o < page[i].until && page[i].until - page[i].start >= 0.01) {
        return { page, index: i };
      }
    }
  }
  return null;
}

function setFont(ctx: CanvasRenderingContext2D, font: CaptionFont, size: number, k: number): void {
  ctx.font = `${size * font.emPerSize * k}px "${cssFontFamily(font)}"`;
}

/**
 * Break words into lines the way libass does (smart wrapping): one line if
 * it fits, else two lines as even as possible with the top one wider, else
 * as many lines as it takes.
 */
function wrapLines(widths: number[], space: number, maxWidth: number): number[][] {
  const lineWidth = (from: number, to: number) =>
    widths.slice(from, to).reduce((a, b) => a + b, 0) + space * Math.max(0, to - from - 1);
  const n = widths.length;
  if (lineWidth(0, n) <= maxWidth || n === 1) return [widths.map((_, i) => i)];
  let best = -1;
  for (let i = 1; i < n; i++) {
    const top = lineWidth(0, i);
    const bottom = lineWidth(i, n);
    if (top <= maxWidth && bottom <= maxWidth && top >= bottom) {
      if (best < 0 || top < lineWidth(0, best)) best = i;
    }
  }
  if (best < 0) {
    for (let i = 1; i < n; i++) {
      if (lineWidth(0, i) <= maxWidth && lineWidth(i, n) <= maxWidth) {
        best = i;
        break;
      }
    }
  }
  if (best > 0) {
    return [
      widths.slice(0, best).map((_, i) => i),
      widths.slice(best).map((_, i) => best + i),
    ];
  }
  // Greedy for anything longer.
  const lines: number[][] = [];
  let line: number[] = [];
  for (let i = 0; i < n; i++) {
    const candidate = [...line, i];
    if (line.length > 0 && lineWidth(candidate[0], i + 1) > maxWidth) {
      lines.push(line);
      line = [i];
    } else {
      line = candidate;
    }
  }
  if (line.length) lines.push(line);
  return lines;
}

/** Draw the captions for clip time `o`. `k` = canvas pixels per output pixel. */
export function drawCaptions(
  ctx: CanvasRenderingContext2D,
  pages: CaptionPage[],
  o: number,
  settings: CaptionSettings,
  m: CaptionMetrics,
  out: OutputSize,
  k: number,
): void {
  if (!settings.enabled) return;
  const current = activeCaption(pages, o, settings);
  if (!current) return;
  const { page, index } = current;
  const font = m.font;
  setFont(ctx, font, m.fontSize, k);
  ctx.textBaseline = 'alphabetic';
  const space = ctx.measureText(' ').width;
  const scaleOf = (i: number) => (i === index ? m.activeScale : 1);
  const widths = page.map((w, i) => ctx.measureText(w.text).width * scaleOf(i));
  const lines = wrapLines(widths, space, (out.w - 2 * m.marginX) * k);
  const lineHeight = m.fontSize * k;
  const top = m.centerY * k - (lines.length * lineHeight) / 2;

  const placed = lines.flatMap((line, row) => {
    const width = line.reduce((sum, i) => sum + widths[i], 0) + space * (line.length - 1);
    let x = m.centerX * k - width / 2;
    const lineTop = top + row * lineHeight;
    return line.map((i) => {
      const at = { i, x, lineTop, baseline: lineTop + font.ascent * lineHeight };
      x += widths[i] + space;
      return at;
    });
  });

  // "Ord för ord": the word pops in from a smaller size, around the middle.
  // A single word too long for the frame is shrunk to fit (as in the .ass).
  let pop = pageScale(page, m.maxChars);
  if (settings.preset === 'word' && index >= 0) {
    pop *= m.popFrom + (1 - m.popFrom) * Math.min(1, (o - page[index].start) / 0.1);
  }
  ctx.save();
  if (pop !== 1) {
    ctx.translate(m.centerX * k, m.centerY * k);
    ctx.scale(pop, pop);
    ctx.translate(-m.centerX * k, -m.centerY * k);
  }

  if (settings.preset === 'box' && index >= 0) {
    const at = placed.find((p) => p.i === index);
    if (at) {
      const pad = m.boxPad * k;
      ctx.fillStyle = settings.highlightColor;
      ctx.fillRect(at.x - pad, at.lineTop - pad, widths[index] + 2 * pad, lineHeight + 2 * pad);
    }
  }

  const drawWord = (p: (typeof placed)[number], dx: number, dy: number, paint: (text: string) => void) => {
    const s = scaleOf(p.i);
    ctx.save();
    ctx.translate(p.x + dx, p.baseline + dy);
    if (s !== 1) ctx.scale(s, s);
    paint(page[p.i].text);
    ctx.restore();
  };
  const outline = 2 * m.outline * k;
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  // Shadow of the outlined text, then the outline, then the letters.
  const shadow = m.shadow * k;
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = outline;
  for (const p of placed) {
    drawWord(p, shadow, shadow, (text) => {
      ctx.strokeText(text, 0, 0);
      ctx.fillText(text, 0, 0);
    });
  }
  ctx.strokeStyle = '#000';
  for (const p of placed) drawWord(p, 0, 0, (text) => ctx.strokeText(text, 0, 0));
  for (const p of placed) {
    ctx.fillStyle = wordColor(settings, page[p.i], p.i === index);
    drawWord(p, 0, 0, (text) => ctx.fillText(text, 0, 0));
  }
  ctx.restore();
}

/** The title at the top: dark text on a white box per line. */
export function drawTitle(
  ctx: CanvasRenderingContext2D,
  text: string,
  t: TitleMetrics,
  out: OutputSize,
  k: number,
): void {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return;
  setFont(ctx, t.font, t.fontSize, k);
  ctx.textBaseline = 'alphabetic';
  const space = ctx.measureText(' ').width;
  const widths = words.map((w) => ctx.measureText(w).width);
  const lines = wrapLines(widths, space, (out.w - 2 * t.marginX) * k);
  const lineHeight = t.fontSize * k;
  const pad = t.boxPad * k;
  const rows = lines.map((line, row) => {
    const width = line.reduce((sum, i) => sum + widths[i], 0) + space * (line.length - 1);
    return { line, width, x: t.centerX * k - width / 2, top: t.top * k + row * lineHeight };
  });
  ctx.fillStyle = '#fff';
  for (const r of rows) ctx.fillRect(r.x - pad, r.top - pad, r.width + 2 * pad, lineHeight + 2 * pad);
  ctx.fillStyle = '#141414';
  for (const r of rows) {
    ctx.fillText(r.line.map((i) => words[i]).join(' '), r.x, r.top + t.font.ascent * lineHeight);
  }
}
