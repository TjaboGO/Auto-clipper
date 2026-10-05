'use client';

import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import type { CaptionMetrics, CaptionPage, TitleMetrics } from '@/lib/edit/captionLayout';
import { cxAt, playableTime, toOutputTime, toSourceTime } from '@/lib/edit/timeline';
import { logoRect } from '@/lib/edit/layout';
import type { ClipEdit, LogoImage, TimeRange } from '@/lib/edit/types';
import { drawCaptions, drawCropView, drawFrame, drawLogo, drawTitle, type FrameSpec } from './draw';
import { formatTime } from './format';
import type { PreviewInfo } from './types';

export interface PreviewHandle {
  /** Jump to a source time. */
  seek: (t: number) => void;
  toggle: () => void;
  pause: () => void;
}

interface PreviewProps {
  ref?: Ref<PreviewHandle>;
  preview: PreviewInfo;
  onRetry: () => void;
  /** Source time where the preview video starts. */
  windowStart: number;
  spec: FrameSpec;
  edit: ClipEdit;
  kept: TimeRange[];
  duration: number;
  pages: CaptionPage[];
  metrics: CaptionMetrics;
  titleMetrics: TitleMetrics;
  cropMode: boolean;
  /** Manual framing: crop centered at `cx` from source time `t` on. */
  onReframe: (t: number, cx: number) => void;
  /** The playhead moved (source time, a few times a second). */
  onTime: (t: number) => void;
  fontsReady: boolean;
  /** Your logo, if you've uploaded one (edit.logo says whether it shows). */
  logo: LogoImage | null;
}

export function Preview(props: PreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const dragCx = useRef<number | null>(null);
  const lastReport = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(props.edit.start);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const logoImage = useRef<HTMLImageElement | null>(null);
  const [logoLoads, setLogoLoads] = useState(0);

  const sourceTime = () => propsRef.current.windowStart + (videoRef.current?.currentTime ?? 0);

  const draw = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!video || !canvas || !ctx) return;
    const p = propsRef.current;
    const t = p.windowStart + video.currentTime;
    if (p.cropMode) {
      drawCropView(ctx, video, p.spec, dragCx.current ?? cxAt(p.spec.keyframes, t));
      return;
    }
    drawFrame(ctx, video, p.spec, t);
    const k = canvas.width / p.spec.out.w;
    const o = toOutputTime(p.kept, t);
    if (o !== null) {
      if (p.edit.logo.enabled && p.logo && logoImage.current) {
        drawLogo(ctx, logoImage.current, logoRect(p.spec.out, p.logo, p.edit.logo), p.edit.logo.opacity, k);
      }
      drawCaptions(ctx, p.pages, o, p.edit.captions, p.metrics, p.spec.out, k);
      if (p.edit.title.enabled && o < p.titleMetrics.until) {
        drawTitle(ctx, p.edit.title.text, p.titleMetrics, p.spec.out, k);
      }
    } else {
      // Paused on something that isn't in the clip: say so.
      const label = t < p.edit.start || t > p.edit.end ? 'Utanför klippet' : 'Bortklippt';
      ctx.fillStyle = 'rgba(10,10,15,0.55)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#fff';
      ctx.font = `600 ${Math.round(canvas.width / 16)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, canvas.width / 2, canvas.height / 2);
      ctx.textAlign = 'start';
    }
  }, []);

  const report = useCallback((force = false) => {
    const now = performance.now();
    if (!force && now - lastReport.current < 90) return;
    lastReport.current = now;
    const t = sourceTime();
    setTime(t);
    propsRef.current.onTime(t);
  }, []);

  const seek = useCallback(
    (t: number) => {
      const video = videoRef.current;
      if (!video) return;
      video.currentTime = Math.max(0, t - propsRef.current.windowStart);
      setTime(t);
      propsRef.current.onTime(t);
    },
    [],
  );

  // While playing: skip over cuts, stop at the end, draw every frame.
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const video = videoRef.current;
      if (!video) return;
      const p = propsRef.current;
      if (!video.paused) {
        const t = p.windowStart + video.currentTime;
        const next = playableTime(p.kept, t);
        if (next === null) {
          video.pause();
          seek(p.kept.length ? p.kept[p.kept.length - 1].end : p.edit.end);
        } else if (next > t + 0.02) {
          video.currentTime = next - p.windowStart;
        }
      }
      draw();
      report();
      if (!video.paused) frame = requestAnimationFrame(tick);
    };
    const video = videoRef.current;
    if (!video) return;
    const onPlay = () => {
      setPlaying(true);
      frame = requestAnimationFrame(tick);
    };
    const onPause = () => {
      setPlaying(false);
      cancelAnimationFrame(frame);
      draw();
      report(true);
    };
    const onSeeked = () => {
      draw();
      report(true);
    };
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('loadeddata', onSeeked);
    return () => {
      cancelAnimationFrame(frame);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('loadeddata', onSeeked);
    };
  }, [draw, report, seek, props.preview.url]);

  const toggle = useCallback(() => {
    const video = videoRef.current;
    if (!video || !propsRef.current.preview.url) return;
    if (!video.paused) {
      video.pause();
      return;
    }
    const p = propsRef.current;
    const t = sourceTime();
    const next = playableTime(p.kept, t);
    const inClip = t >= p.edit.start - 0.01 && t < p.edit.end;
    if (next === null || !inClip) seek(p.kept.length ? p.kept[0].start : p.edit.start);
    else if (next > t) seek(next);
    video.play().catch(() => undefined);
  }, [seek]);

  const pause = useCallback(() => videoRef.current?.pause(), []);

  useImperativeHandle(props.ref, () => ({ seek, toggle, pause }), [seek, toggle, pause]);

  // Start on the clip's first frame once the video is there.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !props.preview.url) return;
    const start = () => seek(propsRef.current.kept[0]?.start ?? propsRef.current.edit.start);
    if (video.readyState >= 1) start();
    else video.addEventListener('loadedmetadata', start, { once: true });
    return () => video.removeEventListener('loadedmetadata', start);
  }, [props.preview.url, seek]);

  // The logo image, loaded again only when it's replaced.
  const logoVersion = props.logo?.version;
  useEffect(() => {
    logoImage.current = null;
    if (!logoVersion) return;
    const image = new Image();
    image.onload = () => {
      logoImage.current = image;
      setLogoLoads((n) => n + 1);
    };
    image.src = `/api/brand/logo?v=${logoVersion}`;
  }, [logoVersion]);

  // Redraw whenever anything that shows changes.
  useEffect(() => {
    draw();
  }, [draw, props.spec, props.edit, props.pages, props.metrics, props.cropMode, props.fontsReady, props.logo, logoLoads, size]);

  // If the start of the clip was just cut away (or moved later), don't sit
  // on something that's no longer in it: go to the new first frame.
  const firstKept = props.kept[0]?.start;
  useEffect(() => {
    const video = videoRef.current;
    if (!video || firstKept === undefined || !video.paused || video.readyState < 1) return;
    const t = sourceTime();
    if (t < firstKept - 0.01 && t >= propsRef.current.edit.start - 0.5) seek(firstKept);
  }, [firstKept, seek]);

  // Fit the canvas to the space it has, in the output's shape (the source's while cropping).
  const aspect = props.cropMode
    ? props.spec.source.width / props.spec.source.height
    : props.spec.out.w / props.spec.out.h;
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const fit = () => {
      const { clientWidth: bw, clientHeight: bh } = box;
      const w = Math.min(bw, bh * aspect);
      setSize({ w: Math.floor(w), h: Math.floor(w / aspect) });
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(box);
    return () => observer.disconnect();
  }, [aspect]);

  const dpr = typeof window === 'undefined' ? 1 : Math.min(2, window.devicePixelRatio || 1);
  const pixelWidth = Math.max(2, Math.round(Math.min(size.w * dpr, props.cropMode ? 1920 : props.spec.out.w)));
  const pixelHeight = Math.max(2, Math.round(pixelWidth / aspect));

  // Dragging the crop window in manual framing.
  const cxFromPointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  };
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!props.cropMode) {
      toggle();
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    pause();
    dragCx.current = cxFromPointer(e);
    draw();
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (dragCx.current === null) return;
    dragCx.current = cxFromPointer(e);
    draw();
  };
  const onPointerUp = () => {
    if (dragCx.current === null) return;
    const cx = dragCx.current;
    dragCx.current = null;
    props.onReframe(sourceTime(), cx);
  };

  const outTime = toOutputTime(props.kept, time);
  const shownTime = outTime ?? (time >= props.edit.end ? props.duration : 0);

  return (
    <div className="flex flex-col h-full min-h-0 gap-3">
      <div ref={boxRef} className="relative flex-1 min-h-0 flex items-center justify-center">
        <canvas
          ref={canvasRef}
          width={pixelWidth}
          height={pixelHeight}
          style={{ width: size.w, height: size.h }}
          className={`rounded-lg bg-black shadow-2xl ${props.cropMode ? 'cursor-ew-resize' : 'cursor-pointer'}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          aria-label="Förhandsvisning"
        />
        {props.preview.status !== 'ready' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-sm text-gray-300 text-center px-6">
            {props.preview.status === 'error' ? (
              <>
                <p>{props.preview.error ?? 'Förhandsvisningen kunde inte göras.'}</p>
                <button
                  type="button"
                  onClick={props.onRetry}
                  className="px-3 py-1.5 rounded-lg bg-base-800 hover:bg-base-700"
                >
                  Försök igen
                </button>
              </>
            ) : props.preview.status === 'unavailable' ? (
              <p>Källvideon finns inte kvar, så det går inte att förhandsvisa.</p>
            ) : (
              <>
                <span className="h-6 w-6 rounded-full border-2 border-accent-400 border-t-transparent animate-spin" />
                <p>Förbereder förhandsvisningen ...</p>
              </>
            )}
          </div>
        )}
        {props.cropMode && props.preview.status === 'ready' && (
          <p className="absolute bottom-2 left-1/2 -translate-x-1/2 text-xs bg-black/70 rounded px-2 py-1 whitespace-nowrap">
            Dra rutan dit bilden ska vara från {formatTime(Math.max(0, time - props.edit.start))}
          </p>
        )}
      </div>
      {props.preview.url && (
        // Off screen but rendered: some browsers stop decoding hidden videos.
        <video
          ref={videoRef}
          src={props.preview.url}
          preload="auto"
          playsInline
          className="absolute w-px h-px opacity-0 pointer-events-none"
        />
      )}
      <div className="flex items-center gap-3 px-1">
        <button
          type="button"
          onClick={toggle}
          disabled={props.preview.status !== 'ready'}
          className="h-9 w-9 shrink-0 rounded-full bg-accent-500 hover:bg-accent-400 disabled:opacity-40 flex items-center justify-center"
          aria-label={playing ? 'Pausa' : 'Spela'}
          title={playing ? 'Pausa (mellanslag)' : 'Spela (mellanslag)'}
        >
          {playing ? (
            <svg viewBox="0 0 24 24" className="h-4 w-4 fill-white" aria-hidden>
              <rect x="6" y="5" width="4" height="14" rx="1" />
              <rect x="14" y="5" width="4" height="14" rx="1" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" className="h-4 w-4 fill-white ml-0.5" aria-hidden>
              <path d="M7 5.5v13a1 1 0 0 0 1.5.86l11-6.5a1 1 0 0 0 0-1.72l-11-6.5A1 1 0 0 0 7 5.5z" />
            </svg>
          )}
        </button>
        <input
          type="range"
          min={0}
          max={Math.max(0.01, props.duration)}
          step={0.01}
          value={Math.min(shownTime, props.duration)}
          onChange={(e) => seek(toSourceTime(props.kept, Number(e.target.value)))}
          className="flex-1 accent-accent-500"
          aria-label="Spola"
        />
        <span className="text-xs tabular-nums text-gray-400 shrink-0">
          {formatTime(shownTime)} / {formatTime(props.duration)}
        </span>
      </div>
    </div>
  );
}
