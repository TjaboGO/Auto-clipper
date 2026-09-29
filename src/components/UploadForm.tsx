'use client';

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { AspectIcon, CaptionPresetPicker } from '@/components/CaptionStyleParts';
import { useCaptionFonts } from '@/components/editor/useCaptionFonts';
import { ASPECT_LABELS } from '@/lib/edit/layout';
import { captionPreset } from '@/lib/edit/presets';
import type { AspectRatio } from '@/lib/edit/types';
import {
  CLIP_LENGTHS,
  clipLength,
  defaultJobOptions,
  MAX_TOPIC_LENGTH,
  MIN_RANGE_SECONDS,
  parseTime,
  sanitizeJobOptions,
  type JobOptions,
} from '@/lib/jobOptions';

type Mode = 'upload' | 'youtube';

interface CreateJobResponse {
  jobId?: string;
  error?: string;
}

// The choices that carry over to the next video (not the topic or the part of the video).
const SAVED_OPTIONS_KEY = 'auto-clipper:options';

/**
 * Send the video as the raw request body (the server streams it straight to
 * disk) and report upload progress, which fetch() can't do.
 */
function uploadFile(
  file: File,
  clipCount: number,
  options: JobOptions,
  onProgress: (fraction: number) => void,
): Promise<{ ok: boolean; data: CreateJobResponse }> {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      filename: file.name,
      clipCount: String(clipCount),
      options: JSON.stringify(options),
    });
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/jobs?${params}`);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let data: CreateJobResponse = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        data = { error: `Servern svarade med ${xhr.status}.` };
      }
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, data });
    };
    xhr.onerror = () => reject(new Error('Uppladdningen misslyckades. Kolla anslutningen.'));
    xhr.send(file);
  });
}

export function UploadForm() {
  const router = useRouter();
  const fontsReady = useCaptionFonts();
  const [mode, setMode] = useState<Mode>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState('');
  const [clipCount, setClipCount] = useState(6);
  const [options, setOptions] = useState<JobOptions>(defaultJobOptions());
  const [showSettings, setShowSettings] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Start with what was picked last time.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(SAVED_OPTIONS_KEY);
      if (saved) setOptions({ ...sanitizeJobOptions(JSON.parse(saved)), topic: '', range: null });
    } catch {
      // private mode or broken JSON: keep the defaults
    }
  }, []);

  const set = (patch: Partial<JobOptions>) => {
    const next = { ...options, ...patch };
    setOptions(next);
    try {
      const { topic: _topic, range: _range, ...keep } = next;
      localStorage.setItem(SAVED_OPTIONS_KEY, JSON.stringify(keep));
    } catch {
      // not saved, no big deal
    }
  };

  /** The part of the video from the Från/Till fields, or an error message. */
  function readRange(): JobOptions['range'] | string {
    if (!from.trim() && !to.trim()) return null;
    const start = from.trim() ? parseTime(from) : 0;
    const end = parseTime(to);
    if (start === null || (to.trim() && end === null)) return 'Skriv tiderna som m:ss, till exempel 12:30.';
    if (end === null) return 'Fyll i var delen ska sluta.';
    if (end - start < MIN_RANGE_SECONDS) return `Delen måste vara minst ${MIN_RANGE_SECONDS} sekunder lång.`;
    return { start, end };
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (mode === 'upload' && !file) {
      setError('Välj en videofil först.');
      return;
    }
    if (mode === 'youtube' && !url.trim()) {
      setError('Klistra in en video-länk först.');
      return;
    }
    const range = readRange();
    if (typeof range === 'string') {
      setError(range);
      setShowSettings(true);
      return;
    }
    const jobOptions = { ...options, range };

    setSubmitting(true);
    try {
      let result: { ok: boolean; data: CreateJobResponse };
      if (mode === 'upload' && file) {
        setUploadProgress(0);
        result = await uploadFile(file, clipCount, jobOptions, setUploadProgress);
      } else {
        const res = await fetch('/api/jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ youtubeUrl: url.trim(), clipCount, options: jobOptions }),
        });
        result = { ok: res.ok, data: await res.json() };
      }

      if (!result.ok || !result.data.jobId) throw new Error(result.data.error || 'Något gick fel.');
      router.push(`/jobs/${result.data.jobId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Något gick fel.');
      setSubmitting(false);
      setUploadProgress(null);
    }
  }

  const buttonLabel = !submitting
    ? 'Skapa klipp'
    : uploadProgress !== null && uploadProgress < 1
      ? `Laddar upp ... ${Math.round(uploadProgress * 100)}%`
      : 'Startar ...';

  const summary = [
    `${clipLength(options.clipLength).label === 'Auto' ? 'Auto längd' : clipLength(options.clipLength).hint}`,
    options.aspect,
    captionPreset(options.captionPreset).label,
    options.keywords ? 'nyckelord' : null,
    from || to ? `${from || '0:00'}-${to || 'slut'}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <form onSubmit={handleSubmit} className="w-full max-w-xl mx-auto">
      <div className="flex gap-2 mb-6 bg-base-900 p-1 rounded-xl w-fit mx-auto">
        <TabButton active={mode === 'upload'} onClick={() => setMode('upload')}>
          Ladda upp fil
        </TabButton>
        <TabButton active={mode === 'youtube'} onClick={() => setMode('youtube')}>
          YouTube-länk
        </TabButton>
      </div>

      {mode === 'upload' ? (
        <label className="flex flex-col items-center justify-center border-2 border-dashed border-base-700 rounded-xl2 p-10 cursor-pointer hover:border-accent-500 transition-colors bg-base-900/50">
          <input
            type="file"
            accept="video/*"
            className="hidden"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <span className="text-4xl mb-3" aria-hidden>
            🎬
          </span>
          <span className="text-sm text-gray-300 text-center px-4">
            {file ? file.name : 'Klicka för att välja en video (mp4, mov, ...)'}
          </span>
        </label>
      ) : (
        <input
          type="url"
          placeholder="https://youtube.com/watch?v=..."
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="w-full rounded-xl2 bg-base-900 border border-base-700 px-4 py-4 text-sm focus:outline-none focus:border-accent-500"
        />
      )}

      <label className="block mt-5">
        <span className="text-sm text-gray-400">Hitta ögonblick om (valfritt)</span>
        <input
          type="text"
          value={options.topic}
          maxLength={MAX_TOPIC_LENGTH}
          onChange={(e) => setOptions({ ...options, topic: e.target.value })}
          placeholder="t.ex. pengar, träning eller när de pratar om AI"
          className="mt-1.5 w-full rounded-xl bg-base-900 border border-base-700 px-4 py-3 text-sm focus:outline-none focus:border-accent-500"
        />
      </label>

      <div className="flex items-center justify-between mt-5">
        <label htmlFor="clipCount" className="text-sm text-gray-400">
          Antal klipp
        </label>
        <div className="flex items-center gap-3">
          <input
            id="clipCount"
            type="range"
            min={1}
            max={12}
            value={clipCount}
            onChange={(e) => setClipCount(parseInt(e.target.value, 10))}
            className="accent-accent-500"
          />
          <span className="w-6 text-center text-sm tabular-nums">{clipCount}</span>
        </div>
      </div>

      <div className="mt-5 mb-6 rounded-xl2 border border-base-800 bg-base-900/40">
        <button
          type="button"
          onClick={() => setShowSettings(!showSettings)}
          aria-expanded={showSettings}
          className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left"
        >
          <span className="text-sm font-medium">Inställningar</span>
          <span className="flex items-center gap-2 min-w-0 text-xs text-gray-400">
            <span className="truncate">{summary}</span>
            <span className={`transition-transform ${showSettings ? 'rotate-180' : ''}`} aria-hidden>
              ▾
            </span>
          </span>
        </button>
        {showSettings && (
          <div className="px-4 pb-4 space-y-5">
            <Field label="Klipplängd">
              <div className="grid grid-cols-5 gap-1.5">
                {CLIP_LENGTHS.map((l) => (
                  <Choice key={l.id} active={options.clipLength === l.id} onClick={() => set({ clipLength: l.id })}>
                    <span className="block text-xs font-medium">{l.label}</span>
                    <span className="block text-[10px] text-gray-400">{l.hint}</span>
                  </Choice>
                ))}
              </div>
            </Field>
            <Field label="Format">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                {(Object.keys(ASPECT_LABELS) as AspectRatio[]).map((a) => (
                  <Choice key={a} active={options.aspect === a} onClick={() => set({ aspect: a })}>
                    <span className="flex items-center gap-1.5 text-xs">
                      <AspectIcon aspect={a} />
                      {ASPECT_LABELS[a]}
                    </span>
                  </Choice>
                ))}
              </div>
            </Field>
            <Field label="Textstil">
              <CaptionPresetPicker
                value={options.captionPreset}
                onChange={(id) => set({ captionPreset: id })}
                fontsReady={fontsReady}
                columns="grid-cols-2 sm:grid-cols-3"
              />
            </Field>
            <label className="flex items-start justify-between gap-4 cursor-pointer">
              <span>
                <span className="block text-sm">Markera nyckelord</span>
                <span className="block text-xs text-gray-400">
                  AI:n väljer de viktigaste orden i varje klipp och visar dem i en egen färg.
                </span>
              </span>
              <input
                type="checkbox"
                checked={options.keywords}
                onChange={(e) => set({ keywords: e.target.checked })}
                className="mt-1 h-4 w-4 accent-accent-500"
              />
            </label>
            <Field label="Bara en del av videon (valfritt)">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  inputMode="numeric"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  placeholder="Från 0:00"
                  aria-label="Från"
                  className="w-full rounded-lg bg-base-900 border border-base-700 px-3 py-2 text-sm focus:outline-none focus:border-accent-500"
                />
                <span className="text-gray-500">-</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  placeholder="Till t.ex. 45:00"
                  aria-label="Till"
                  className="w-full rounded-lg bg-base-900 border border-base-700 px-3 py-2 text-sm focus:outline-none focus:border-accent-500"
                />
              </div>
              <p className="text-xs text-gray-500 mt-1">
                Lämna tomt för hela videon. Går fortare och billigare för långa videor.
              </p>
            </Field>
          </div>
        )}
      </div>

      {error && <p className="text-red-400 text-sm mb-4">{error}</p>}

      <button
        type="submit"
        disabled={submitting}
        className="relative w-full overflow-hidden rounded-xl2 bg-accent-500 hover:bg-accent-400 disabled:opacity-60 disabled:cursor-not-allowed py-4 font-medium transition-colors"
      >
        {uploadProgress !== null && (
          <span
            className="absolute inset-y-0 left-0 bg-accent-600 transition-[width]"
            style={{ width: `${Math.round(uploadProgress * 100)}%` }}
            aria-hidden
          />
        )}
        <span className="relative tabular-nums">{buttonLabel}</span>
      </button>
    </form>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">{label}</p>
      {children}
    </div>
  );
}

function Choice({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-lg border px-2 py-2 text-left ${active ? 'border-accent-500 bg-accent-500/10' : 'border-base-700 hover:border-base-600'}`}
    >
      {children}
    </button>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
        active ? 'bg-accent-500 text-white' : 'text-gray-400 hover:text-white'
      }`}
    >
      {children}
    </button>
  );
}
