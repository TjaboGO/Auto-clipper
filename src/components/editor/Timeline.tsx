'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { MIN_CLIP_SECONDS } from '@/lib/edit/presets';
import { endAfterWord, startBeforeWord } from '@/lib/edit/timeline';
import type { ClipEdit, EditorWord, ReframeKey, TimeRange } from '@/lib/edit/types';
import { formatOffset } from './format';

interface TimelineProps {
  window: TimeRange;
  peaks: { rate: number; values: number[] } | null;
  edit: ClipEdit;
  cuts: TimeRange[];
  words: EditorWord[];
  /** Playhead, source time. */
  time: number;
  reframe: ReframeKey[];
  onSeek: (t: number) => void;
  /** New clip edges while dragging a handle; `key` groups one drag into one undo step. */
  onRange: (start: number, end: number, key: string) => void;
}

const HEIGHT = 96;
const SNAP_PX = 10;
// Room on both sides, so the handles stay reachable at the window's edges.
const PAD = 16;

/**
 * The clip on a timeline of the source around it: the waveform, the clip's
 * edges as handles (they snap to word boundaries), removed parts hatched in
 * red, and the playhead. Zoom in for precision.
 */
export function Timeline(props: TimelineProps) {
  const { window: win, edit } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(800);
  const [pps, setPps] = useState<number | null>(null); // pixels per second
  const [scrollLeft, setScrollLeft] = useState(0);
  const drag = useRef<{ kind: 'start' | 'end' | 'seek'; key: string } | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  const windowLength = win.end - win.start;
  const minPps = Math.max(1, (width - 2 * PAD) / windowLength);
  const zoom = Math.max(minPps, pps ?? Math.max(minPps, width / ((edit.end - edit.start) * 1.25)));
  const contentWidth = Math.max(width, windowLength * zoom + 2 * PAD);
  const x = useCallback((t: number) => PAD + (t - win.start) * zoom, [win.start, zoom]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  // Start with the clip in the middle.
  const centered = useRef(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || centered.current || width <= 0) return;
    centered.current = true;
    el.scrollLeft = x((edit.start + edit.end) / 2) - width / 2;
  }, [width, x, edit.start, edit.end]);

  // Keep the playhead in view while it moves.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || drag.current) return;
    const px = x(props.time);
    if (px < el.scrollLeft || px > el.scrollLeft + width) el.scrollLeft = px - width / 3;
  }, [props.time, x, width]);

  // Draw the visible part.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(HEIGHT * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, HEIGHT);
    const from = win.start + (scrollLeft - PAD) / zoom;
    const to = from + width / zoom;
    const px = (t: number) => (t - from) * zoom;
    const top = 18;
    const mid = top + (HEIGHT - top - 14) / 2;
    const amp = (HEIGHT - top - 14) / 2;

    // Time ticks, 0 = clip start.
    const step = [1, 2, 5, 10, 15, 30, 60].find((s) => s * zoom >= 60) ?? 120;
    ctx.fillStyle = '#6b7280';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    const firstTick = Math.ceil((from - edit.start) / step) * step;
    for (let s = firstTick; edit.start + s <= to; s += step) {
      const tx = px(edit.start + s);
      ctx.fillRect(tx, 0, 1, 5);
      ctx.fillText(formatOffset(s), tx + 3, 1);
    }

    // Waveform.
    const { cuts } = propsRef.current;
    const inCut = (t: number) => cuts.some((c) => t >= c.start && t < c.end);
    const peaks = props.peaks;
    if (peaks && peaks.values.length) {
      const barEvery = Math.max(1 / peaks.rate, 2 / zoom);
      for (let t = Math.max(win.start, from); t < Math.min(win.end, to); t += barEvery) {
        const i = Math.floor((t - win.start) * peaks.rate);
        const v = (peaks.values[i] ?? 0) / 100;
        const inside = t >= edit.start && t <= edit.end;
        ctx.fillStyle = !inside ? '#3a3a46' : inCut(t) ? '#f87171' : '#9c85ff';
        const h = Math.max(1, v * amp);
        ctx.fillRect(px(t), mid - h, Math.max(1, barEvery * zoom - 1), h * 2);
      }
    } else {
      ctx.fillStyle = '#26262f';
      ctx.fillRect(0, mid - 1, width, 2);
    }

    // Removed parts: hatched red.
    for (const c of cuts) {
      const cx0 = px(c.start);
      const cw = (c.end - c.start) * zoom;
      ctx.fillStyle = 'rgba(248,113,113,0.18)';
      ctx.fillRect(cx0, top, cw, HEIGHT - top - 14);
      ctx.save();
      ctx.beginPath();
      ctx.rect(cx0, top, cw, HEIGHT - top - 14);
      ctx.clip();
      ctx.strokeStyle = 'rgba(248,113,113,0.5)';
      ctx.lineWidth = 1;
      for (let hx = cx0 - HEIGHT; hx < cx0 + cw; hx += 8) {
        ctx.beginPath();
        ctx.moveTo(hx, HEIGHT);
        ctx.lineTo(hx + HEIGHT, top);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Outside the clip: darker.
    ctx.fillStyle = 'rgba(10,10,15,0.55)';
    ctx.fillRect(0, top, Math.max(0, px(edit.start)), HEIGHT - top - 14);
    ctx.fillRect(px(edit.end), top, Math.max(0, width - px(edit.end)), HEIGHT - top - 14);
    ctx.fillStyle = '#7c5cff';
    ctx.fillRect(px(edit.start), top - 2, (edit.end - edit.start) * zoom, 2);
    ctx.fillRect(px(edit.start), HEIGHT - 16, (edit.end - edit.start) * zoom, 2);

    // Words, when zoomed in far enough to read them.
    if (zoom >= 45) {
      ctx.fillStyle = '#d1d5db';
      ctx.font = '11px system-ui, sans-serif';
      ctx.textBaseline = 'bottom';
      let lastEnd = -Infinity;
      for (const w of props.words) {
        const wx = px(w.start);
        if (wx < -80 || wx > width + 10 || wx < lastEnd + 4) continue;
        ctx.fillText(w.text, wx, HEIGHT - 1);
        lastEnd = wx + ctx.measureText(w.text).width;
      }
    }
  }, [width, scrollLeft, zoom, win.start, win.end, edit.start, edit.end, props.peaks, props.words, props.cuts]);

  const timeAt = (clientX: number): number => {
    const el = scrollRef.current;
    const rect = el?.getBoundingClientRect();
    if (!el || !rect) return edit.start;
    return win.start + (clientX - rect.left + el.scrollLeft - PAD) / zoom;
  };

  /** Nearest word boundary within SNAP_PX, or the time itself. */
  const snap = (t: number, kind: 'start' | 'end'): number => {
    const words = propsRef.current.words;
    let best = t;
    let bestPx = SNAP_PX;
    words.forEach((_, i) => {
      const b = kind === 'start' ? startBeforeWord(words, i, win) : endAfterWord(words, i, win);
      const d = Math.abs(b - t) * zoom;
      if (d < bestPx) {
        best = b;
        bestPx = d;
      }
    });
    return best;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const handle = (e.target as HTMLElement).dataset.handle as 'start' | 'end' | undefined;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { kind: handle ?? 'seek', key: `range-${Date.now()}` };
    if (!handle) props.onSeek(Math.min(win.end, Math.max(win.start, timeAt(e.clientX))));
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const t = Math.min(win.end, Math.max(win.start, timeAt(e.clientX)));
    const { edit: current } = propsRef.current;
    if (d.kind === 'seek') {
      props.onSeek(t);
    } else if (d.kind === 'start') {
      const start = Math.min(snap(t, 'start'), current.end - MIN_CLIP_SECONDS);
      props.onRange(Math.max(win.start, start), current.end, d.key);
      props.onSeek(Math.max(win.start, start));
    } else {
      const end = Math.max(snap(t, 'end'), current.start + MIN_CLIP_SECONDS);
      props.onRange(current.start, Math.min(win.end, end), d.key);
      props.onSeek(Math.max(current.start, Math.min(win.end, end) - 1.5));
    }
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  const zoomBy = (factor: number) => {
    const el = scrollRef.current;
    const center = el ? win.start + (el.scrollLeft + width / 2 - PAD) / zoom : props.time;
    const next = Math.min(400, Math.max(minPps, zoom * factor));
    setPps(next);
    requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollLeft = PAD + (center - win.start) * next - width / 2;
    });
  };
  const zoomRef = useRef(zoomBy);
  zoomRef.current = zoomBy;

  // Ctrl/cmd + scroll zooms (a native listener: React's wheel events can't prevent scrolling).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomRef.current(e.deltaY < 0 ? 1.15 : 1 / 1.15);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  return (
    <div className="select-none">
      <div className="flex items-center justify-between mb-1.5 text-xs text-gray-400">
        <span>Dra i kanterna för att korta eller förlänga klippet. Klicka för att spola.</span>
        <span className="flex items-center gap-1">
          <button type="button" onClick={() => zoomBy(1 / 1.6)} className="h-6 w-6 rounded bg-base-800 hover:bg-base-700" aria-label="Zooma ut">
            −
          </button>
          <button type="button" onClick={() => zoomBy(1.6)} className="h-6 w-6 rounded bg-base-800 hover:bg-base-700" aria-label="Zooma in">
            +
          </button>
        </span>
      </div>
      <div ref={containerRef} className="relative rounded-lg bg-base-900 overflow-hidden" style={{ height: HEIGHT + 12 }}>
        <canvas ref={canvasRef} className="absolute left-0 top-0 pointer-events-none" style={{ width, height: HEIGHT }} />
        <div
          ref={scrollRef}
          className="absolute inset-0 overflow-x-auto overflow-y-hidden"
          onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
        >
          <div
            className="relative cursor-text"
            style={{ width: contentWidth, height: HEIGHT }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            {props.reframe.map((key) => (
              <div
                key={key.t}
                title={key.cx === null ? 'Följer talaren härifrån' : 'Fast beskärning härifrån'}
                className={`absolute top-3 h-2.5 w-2.5 -ml-[5px] rotate-45 pointer-events-none ${key.cx === null ? 'bg-accent-400' : 'bg-white'}`}
                style={{ left: x(key.t) }}
              />
            ))}
            <div
              data-handle="start"
              title="Klippets början"
              className="absolute top-4 bottom-3 w-3 rounded-l-md bg-accent-500 hover:bg-accent-400 cursor-ew-resize"
              style={{ left: x(edit.start) - 12 }}
            />
            <div
              data-handle="end"
              title="Klippets slut"
              className="absolute top-4 bottom-3 w-3 rounded-r-md bg-accent-500 hover:bg-accent-400 cursor-ew-resize"
              style={{ left: x(edit.end) }}
            />
            <div className="absolute top-0 bottom-0 w-0.5 bg-white pointer-events-none" style={{ left: x(props.time) }} />
          </div>
        </div>
      </div>
    </div>
  );
}
