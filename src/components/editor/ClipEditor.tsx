'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { captionMetrics, captionPages, titleMetrics } from '@/lib/edit/captionLayout';
import { OUTPUT_SIZES, resolveLayout, singleCrop } from '@/lib/edit/layout';
import { MIN_CLIP_SECONDS } from '@/lib/edit/presets';
import { CAPTION_FONTS, setCustomFonts } from '@/lib/edit/fonts';
import {
  applyReframe,
  clipWords,
  computeCuts,
  endAfterWord,
  keptRanges,
  outputDuration,
  outputWords,
  removedWordIds,
  startBeforeWord,
  toOutputTime,
  toSourceTime,
} from '@/lib/edit/timeline';
import type { BrandInfo, ClipEdit, WordOverride } from '@/lib/edit/types';
import type { RenderedClip } from '@/lib/types';
import type { FrameSpec } from './draw';
import { formatTime } from './format';
import { previewFormat } from './previewFormat';
import { Preview, type PreviewHandle } from './Preview';
import { SettingsPanel } from './SettingsPanel';
import { Timeline } from './Timeline';
import { Transcript, type Selection } from './Transcript';
import type { EditorPayload, PreviewInfo } from './types';
import { useCaptionFonts } from './useCaptionFonts';
import { useEditHistory } from './useEditHistory';

type SaveState = 'saved' | 'saving' | 'error';

/** Apply `change` to the overrides of the given words, dropping empty ones. */
function withOverrides(edit: ClipEdit, ids: string[], change: (o: WordOverride) => WordOverride): ClipEdit {
  const words = { ...edit.words };
  for (const id of ids) {
    const next = change({ ...words[id] });
    const clean: WordOverride = {};
    if (next.text !== undefined) clean.text = next.text;
    if (next.hidden) clean.hidden = true;
    if (next.emphasis) clean.emphasis = true;
    if (Object.keys(clean).length > 0) words[id] = clean;
    else delete words[id];
  }
  return { ...edit, words };
}

function ToolButton(props: { onClick: () => void; children: React.ReactNode; title?: string; danger?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      title={props.title}
      disabled={props.disabled}
      className={`rounded-md px-2.5 py-1 text-xs font-medium disabled:opacity-40 ${
        props.danger ? 'bg-red-500/20 text-red-200 hover:bg-red-500/30' : 'bg-base-800 hover:bg-base-700'
      }`}
    >
      {props.children}
    </button>
  );
}

export function ClipEditor({ initial }: { initial: EditorPayload }) {
  const jobId = initial.job.id;
  const [data, setData] = useState(initial.data);
  const [clip, setClip] = useState<RenderedClip>(initial.clip);
  const [preview, setPreview] = useState<PreviewInfo>(initial.preview);
  const { edit, set, undo, redo, canUndo, canRedo } = useEditHistory(initial.edit);
  const [brand, setBrand] = useState<BrandInfo>(initial.brand ?? { fonts: [], logo: null, style: null });
  const updateBrand = useCallback((next: BrandInfo) => {
    setCustomFonts(next.fonts);
    setBrand(next);
  }, []);
  const fontsReady = useCaptionFonts([...CAPTION_FONTS, ...brand.fonts]);
  const previewRef = useRef<PreviewHandle>(null);
  const [time, setTime] = useState(initial.edit.start);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [cropMode, setCropMode] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [renderError, setRenderError] = useState<string | null>(null);
  const [rendered, setRendered] = useState(false);
  const savedRef = useRef(initial.edit);
  const editRef = useRef(edit);
  editRef.current = edit;
  const saveFailed = useRef(false);
  saveFailed.current = saveState === 'error';

  const words = data.words;
  const out = OUTPUT_SIZES[edit.aspect];
  const resolved = useMemo(
    () => resolveLayout(edit.layout, edit.aspect, data.source, data.analysis),
    [edit.layout, edit.aspect, data.source, data.analysis],
  );
  const cuts = useMemo(() => computeCuts(edit, words), [edit, words]);
  const kept = useMemo(() => keptRanges(edit, words), [edit, words]);
  const duration = outputDuration(kept);
  const outWords = useMemo(() => outputWords(edit, words, kept), [edit, words, kept]);
  const metrics = useMemo(
    () => captionMetrics(edit.captions, out, resolved.layout, edit.aspect),
    [edit.captions, out, resolved.layout, edit.aspect],
  );
  const pages = useMemo(
    () =>
      captionPages(outWords, duration, {
        maxWords: metrics.maxWords,
        maxChars: metrics.maxChars,
        uppercase: edit.captions.uppercase,
      }),
    [outWords, duration, metrics, edit.captions.uppercase],
  );
  const titleM = useMemo(
    () => titleMetrics(edit.captions, edit.title.duration, out, edit.aspect, duration),
    [edit.captions, edit.title.duration, out, edit.aspect, duration],
  );
  const keyframes = useMemo(
    () => applyReframe(data.analysis?.keyframes ?? [], edit.reframe),
    [data.analysis, edit.reframe],
  );
  const spec: FrameSpec = useMemo(() => {
    const split = data.analysis?.split ?? null;
    return {
      source: data.source,
      out,
      layout: resolved.layout,
      keyframes,
      split: split && edit.splitSwap ? { top: split.bottom, bottom: split.top } : split,
    };
  }, [data.source, data.analysis, out, resolved.layout, keyframes, edit.splitSwap]);
  const inClip = useMemo(() => clipWords(words, edit), [words, edit]);
  const removed = useMemo(() => removedWordIds(edit, inClip), [edit, inClip]);
  const fillerCount = inClip.filter((w) => w.filler).length;
  const estimated = inClip.some((w) => !w.exact);
  const crop = singleCrop(data.source, out);
  const canCrop = crop.pans && crop.w < data.source.width - 2;
  const current = useMemo(() => words.findIndex((w) => time >= w.start && time < w.end), [words, time]);

  const from = selection ? Math.min(selection.anchor, selection.focus) : -1;
  const to = selection ? Math.max(selection.anchor, selection.focus) : -1;
  const selected = selection ? words.slice(from, to + 1) : [];
  const selectedIds = selected.map((w) => w.id);

  // ---- saving -------------------------------------------------------------
  useEffect(() => {
    if (edit === savedRef.current) {
      // e.g. undone back to what's saved before the timer ran
      setSaveState('saved');
      return;
    }
    setSaveState('saving');
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}/clips/${clip.id}/edit`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(edit),
        });
        if (!res.ok) throw new Error(String(res.status));
        savedRef.current = edit;
        if (editRef.current === edit) setSaveState('saved');
      } catch {
        setSaveState('error');
      }
    }, 700);
    return () => clearTimeout(timer);
  }, [edit, jobId, clip.id]);

  // Leaving (another clip, back to the job, closing the tab) saves what the
  // debounced autosave hasn't sent yet.
  useEffect(() => {
    const flush = () => {
      if (editRef.current === savedRef.current) return;
      savedRef.current = editRef.current;
      fetch(`/api/jobs/${jobId}/clips/${clip.id}/edit`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editRef.current),
        keepalive: true,
      }).catch(() => undefined);
    };
    // Only warn when saving has been failing; otherwise the flush takes care of it.
    const warn = (e: BeforeUnloadEvent) => {
      if (saveFailed.current && editRef.current !== savedRef.current) e.preventDefault();
    };
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', warn);
      flush();
    };
  }, [jobId, clip.id]);

  // ---- preview video --------------------------------------------------------
  const pollPreview = useCallback(
    async (retry = false) => {
      const res = await fetch(
        `/api/jobs/${jobId}/clips/${clip.id}/editor?only=preview&format=${previewFormat()}${retry ? '&retry=1' : ''}`,
        { cache: 'no-store' },
      );
      if (res.ok) setPreview((await res.json()).preview);
    },
    [jobId, clip.id],
  );
  useEffect(() => {
    if (preview.status !== 'pending') return;
    const timer = setInterval(() => pollPreview().catch(() => undefined), 1500);
    return () => clearInterval(timer);
  }, [preview.status, pollPreview]);

  // ---- rendering ------------------------------------------------------------
  const rendering = !!clip.renderState && clip.renderState.status !== 'error';
  const startRender = async () => {
    setRenderError(null);
    setRendered(false);
    previewRef.current?.pause();
    const res = await fetch(`/api/jobs/${jobId}/clips/${clip.id}/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(edit),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setRenderError(body.error ?? 'Kunde inte starta renderingen.');
      return;
    }
    savedRef.current = edit;
    setSaveState('saved');
    setClip((c) => ({ ...c, renderState: { status: 'queued', at: new Date().toISOString() } }));
  };

  useEffect(() => {
    if (!rendering) return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}`, { cache: 'no-store' });
        const job = (await res.json()).job;
        const latest: RenderedClip | undefined = job?.clips?.find((c: RenderedClip) => c.id === clip.id);
        if (!latest) return;
        setClip(latest);
        if (latest.renderState?.status === 'error') setRenderError(latest.renderState.error ?? 'Renderingen misslyckades.');
        if (!latest.renderState) {
          setRendered(true);
          // Word times may have been refined and the edges nudged: pick that up.
          const payload: EditorPayload = await (
            await fetch(`/api/jobs/${jobId}/clips/${clip.id}/editor?format=${previewFormat()}`, { cache: 'no-store' })
          ).json();
          if (payload.data) setData(payload.data);
          const local = editRef.current;
          if (payload.edit && local === savedRef.current && (payload.edit.start !== local.start || payload.edit.end !== local.end)) {
            savedRef.current = { ...local, start: payload.edit.start, end: payload.edit.end };
            set(savedRef.current);
          }
        }
      } catch {
        // try again on the next tick
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [rendering, jobId, clip.id, set]);

  // ---- word actions -----------------------------------------------------------
  const allDeleted = selected.length > 0 && selected.every((w) => edit.deleted.includes(w.id));
  const allHidden = selected.length > 0 && selected.every((w) => edit.words[w.id]?.hidden);
  const allEmphasis = selected.length > 0 && selected.every((w) => edit.words[w.id]?.emphasis);

  const toggleCut = useCallback(() => {
    if (selectedIds.length === 0) return;
    const ids = new Set(selectedIds);
    const deleted = allDeleted
      ? edit.deleted.filter((id) => !ids.has(id))
      : [...new Set([...edit.deleted, ...selectedIds])];
    const next = { ...edit, deleted };
    if (keptRanges(next, words).length === 0) return; // never cut everything
    set(next);
  }, [selectedIds, allDeleted, edit, words, set]);

  const toggleHidden = () => set(withOverrides(edit, selectedIds, (o) => ({ ...o, hidden: !allHidden })));
  const toggleEmphasis = () => set(withOverrides(edit, selectedIds, (o) => ({ ...o, emphasis: !allEmphasis })));
  const startHere = () => {
    const start = startBeforeWord(words, from, data.window);
    if (start < edit.end - MIN_CLIP_SECONDS) set({ ...edit, start });
  };
  const endHere = () => {
    const end = endAfterWord(words, to, data.window);
    if (end > edit.start + MIN_CLIP_SECONDS) set({ ...edit, end });
  };
  const editText = (index: number, text: string) => {
    setEditing(null);
    const word = words[index];
    const value = text.trim().replace(/\s+/g, ' ');
    set(
      withOverrides(edit, [word.id], (o) =>
        value === '' ? { ...o, text: undefined, hidden: true } : { ...o, text: value === word.text ? undefined : value },
      ),
    );
  };

  const seekWord = (index: number) => previewRef.current?.seek(words[index].start + 0.01);
  const seekOutput = (delta: number) => {
    const o = toOutputTime(kept, time) ?? 0;
    previewRef.current?.seek(toSourceTime(kept, Math.max(0, Math.min(duration, o + delta))));
  };

  const onReframe = (t: number, cx: number) => {
    const reframe = [...edit.reframe.filter((k) => Math.abs(k.t - t) > 0.05), { t, cx }].sort((a, b) => a.t - b.t);
    set({ ...edit, reframe });
  };

  // ---- keyboard -------------------------------------------------------------
  const keys = useRef({ toggleCut, seekOutput, undo, redo, selection });
  keys.current = { toggleCut, seekOutput, undo, redo, selection };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing =
        target.tagName === 'TEXTAREA' ||
        (target.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'color', 'button'].includes((target as HTMLInputElement).type));
      if (typing) return;
      const k = keys.current;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) k.redo();
        else k.undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        k.redo();
      } else if (e.key === ' ') {
        e.preventDefault();
        previewRef.current?.toggle();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && k.selection) {
        e.preventDefault();
        k.toggleCut();
      } else if (e.key === 'Escape') {
        setSelection(null);
        setCropMode(false);
      } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && (target as HTMLInputElement).type !== 'range') {
        e.preventDefault();
        k.seekOutput((e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 5 : 1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const clipIndex = initial.clips.findIndex((c) => c.id === clip.id);
  const prevClip = initial.clips[clipIndex - 1];
  const nextClip = initial.clips[clipIndex + 1];
  const downloadName = `${clip.title.replace(/[^a-z0-9åäö]+/gi, '_') || 'klipp'}.mp4`;

  return (
    <div className="flex flex-col lg:h-screen">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 border-b border-base-800 shrink-0">
        <Link href={`/jobs/${jobId}`} className="text-sm text-gray-400 hover:text-white shrink-0">
          &larr; Alla klipp
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="font-semibold truncate">{clip.title}</h1>
          <p className="text-xs text-gray-400 flex items-center gap-2">
            {prevClip ? (
              <Link href={`/jobs/${jobId}/clips/${prevClip.id}`} className="hover:text-white" aria-label="Förra klippet">
                ‹
              </Link>
            ) : null}
            <span>
              Klipp {clipIndex + 1} av {initial.clips.length} · {formatTime(duration)}
            </span>
            {nextClip ? (
              <Link href={`/jobs/${jobId}/clips/${nextClip.id}`} className="hover:text-white" aria-label="Nästa klipp">
                ›
              </Link>
            ) : null}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={undo}
            disabled={!canUndo}
            className="h-8 w-8 rounded-md bg-base-800 hover:bg-base-700 disabled:opacity-30"
            title="Ångra (Ctrl+Z)"
            aria-label="Ångra"
          >
            ↶
          </button>
          <button
            type="button"
            onClick={redo}
            disabled={!canRedo}
            className="h-8 w-8 rounded-md bg-base-800 hover:bg-base-700 disabled:opacity-30"
            title="Gör om (Ctrl+Shift+Z)"
            aria-label="Gör om"
          >
            ↷
          </button>
        </div>
        <span className={`hidden sm:inline text-xs w-24 text-right ${saveState === 'error' ? 'text-red-300' : 'text-gray-500'}`}>
          {saveState === 'saving' ? 'Sparar ...' : saveState === 'error' ? 'Kunde inte spara' : 'Sparat'}
        </span>
        {rendered && !rendering && (
          <a
            href={`/api/clips/${jobId}/${clip.filename}`}
            download={downloadName}
            className="text-sm text-accent-300 hover:text-accent-400"
          >
            Ladda ner nya versionen
          </a>
        )}
        <button
          type="button"
          onClick={startRender}
          disabled={rendering}
          className="rounded-lg bg-accent-500 hover:bg-accent-400 disabled:opacity-60 px-4 py-2 text-sm font-semibold flex items-center gap-2"
        >
          {rendering && <span className="h-3.5 w-3.5 rounded-full border-2 border-white border-t-transparent animate-spin" />}
          {clip.renderState?.status === 'queued' ? 'I kö ...' : rendering ? 'Renderar ...' : 'Rendera klipp'}
        </button>
      </header>

      {(renderError || rendered) && (
        <div className={`px-4 py-2 text-sm ${renderError ? 'bg-red-500/15 text-red-200' : 'bg-accent-500/15 text-accent-300'}`}>
          {renderError ?? 'Klart! Den nya versionen finns nu på jobbsidan och kan laddas ner.'}
        </div>
      )}

      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[minmax(260px,1fr)_minmax(300px,1.1fr)_300px] gap-4 p-4">
        <section className="flex flex-col min-h-0 max-h-[60vh] lg:max-h-none bg-base-900/60 rounded-xl p-4 order-2 lg:order-1">
          <div className="flex items-center justify-between gap-2 mb-2">
            <h2 className="text-sm font-semibold">Transkript</h2>
            <div className="flex gap-1.5">
              <ToolButton
                onClick={() => set({ ...edit, removeFillers: !edit.removeFillers })}
                title="Klipp bort eh, öh, hmm ..."
                disabled={fillerCount === 0 && !edit.removeFillers}
              >
                {edit.removeFillers ? '✓ ' : ''}Utfyllnadsord{fillerCount > 0 ? ` (${fillerCount})` : ''}
              </ToolButton>
              <ToolButton onClick={() => set({ ...edit, removePauses: !edit.removePauses })} title="Korta pauser längre än en halv sekund">
                {edit.removePauses ? '✓ ' : ''}Pauser
              </ToolButton>
            </div>
          </div>
          {selection ? (
            <div className="flex flex-wrap items-center gap-1.5 mb-3 rounded-lg bg-base-800/70 p-2">
              <span className="text-xs text-gray-300 mr-1">
                {selected.length} {selected.length === 1 ? 'ord' : 'ord'}
              </span>
              <ToolButton onClick={toggleCut} danger={!allDeleted} title="Delete">
                {allDeleted ? 'Återställ' : 'Klipp bort'}
              </ToolButton>
              <ToolButton onClick={toggleHidden}>{allHidden ? 'Visa i texten' : 'Dölj i texten'}</ToolButton>
              <ToolButton onClick={toggleEmphasis}>{allEmphasis ? 'Avmarkera' : 'Markera'}</ToolButton>
              {selected.length === 1 && <ToolButton onClick={() => setEditing(from)}>Rätta</ToolButton>}
              <ToolButton onClick={startHere} title="Klippet börjar vid det första markerade ordet">
                Börja här
              </ToolButton>
              <ToolButton onClick={endHere} title="Klippet slutar efter det sista markerade ordet">
                Sluta här
              </ToolButton>
              <button type="button" onClick={() => setSelection(null)} className="ml-auto px-1 text-gray-400 hover:text-white" aria-label="Avmarkera">
                ✕
              </button>
            </div>
          ) : (
            <p className="text-xs text-gray-500 mb-3">
              Markera ord för att klippa bort dem, dölja dem i texten eller rätta stavningen. Dubbelklicka
              för att rätta. Grå text ligger utanför klippet.
            </p>
          )}
          {estimated && (
            <p className="text-xs text-amber-300/90 mb-2">
              Ordtiderna är uppskattade här, så klipp mitt i meningar kan bli lite ojämna i förhandsvisningen.
              Vid rendering tas exakta tider fram om det går.
            </p>
          )}
          <Transcript
            words={words}
            edit={edit}
            removed={removed}
            current={current}
            selection={selection}
            onSelect={setSelection}
            onSeekWord={seekWord}
            editing={editing}
            onEditing={setEditing}
            onEditText={editText}
          />
        </section>

        <section className="flex flex-col min-h-[60vh] lg:min-h-0 order-1 lg:order-2">
          <Preview
            ref={previewRef}
            preview={preview}
            onRetry={() => pollPreview(true)}
            windowStart={data.window.start}
            spec={spec}
            edit={edit}
            kept={kept}
            duration={duration}
            pages={pages}
            metrics={metrics}
            titleMetrics={titleM}
            cropMode={cropMode && canCrop && resolved.layout === 'single'}
            onReframe={onReframe}
            onTime={setTime}
            fontsReady={fontsReady}
            logo={brand.logo}
          />
        </section>

        <aside className="min-h-0 bg-base-900/60 rounded-xl p-4 order-3 max-h-[70vh] lg:max-h-none flex flex-col">
          <SettingsPanel
            edit={edit}
            set={set}
            analysis={data.analysis}
            resolved={resolved}
            canCrop={canCrop}
            cropMode={cropMode}
            onCropMode={setCropMode}
            time={time}
            fontsReady={fontsReady}
            brand={brand}
            onBrand={updateBrand}
          />
        </aside>
      </div>

      <footer className="px-4 pb-4 shrink-0">
        <Timeline
          window={data.window}
          peaks={preview.peaks}
          edit={edit}
          cuts={cuts}
          words={words}
          time={time}
          reframe={edit.reframe}
          onSeek={(t) => previewRef.current?.seek(t)}
          onRange={(start, end, key) => set({ ...editRef.current, start, end }, key)}
        />
      </footer>
    </div>
  );
}
