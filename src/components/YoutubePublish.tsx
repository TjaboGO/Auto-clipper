'use client';

import { useState } from 'react';
import Link from 'next/link';
import { PRIVACY_LABELS, type YoutubeRequest } from '@/lib/youtubeMeta';
import type { YoutubePrivacy, YoutubeUpload } from '@/lib/types';

interface FormInfo {
  defaults: YoutubeRequest;
  account: { connected: boolean; channel?: { title: string } };
}

/** A local date-time input value ("2026-11-04T09:00") for a time `minutes` from now. */
function localInput(minutes: number): string {
  const d = new Date(Date.now() + minutes * 60_000);
  d.setSeconds(0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function when(iso: string): string {
  return new Date(iso).toLocaleString('sv-SE', { dateStyle: 'medium', timeStyle: 'short' });
}

/** The clip's latest upload, in a line. */
export function YoutubeStatus({ upload }: { upload: YoutubeUpload }) {
  if (upload.status === 'queued') return <p className="text-xs text-gray-400">YouTube: i kö för uppladdning ...</p>;
  if (upload.status === 'uploading') {
    const percent = Math.round((upload.progress ?? 0) * 100);
    return (
      <div className="space-y-1">
        <p className="text-xs text-gray-400">Laddar upp till YouTube ... {percent} %</p>
        <div className="h-1 rounded bg-base-800 overflow-hidden">
          <div className="h-full bg-accent-500 transition-all" style={{ width: `${percent}%` }} />
        </div>
      </div>
    );
  }
  if (upload.status === 'error') return <p className="text-xs text-red-300">YouTube: {upload.error}</p>;
  return (
    <p className="text-xs text-accent-300">
      {upload.publishAt ? `Schemalagd på YouTube till ${when(upload.publishAt)}. ` : `Uppladdad till YouTube (${PRIVACY_LABELS[upload.privacy].toLowerCase()}). `}
      {upload.url && (
        <a href={upload.url} target="_blank" rel="noreferrer" className="underline hover:text-accent-400">
          Öppna
        </a>
      )}
    </p>
  );
}

/** "Publicera på YouTube": a small form with the title, description, privacy and an optional time. */
export function YoutubePublish({
  jobId,
  clipId,
  upload,
  onStarted,
}: {
  jobId: string;
  clipId: string;
  upload?: YoutubeUpload;
  onStarted?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<FormInfo | null>(null);
  const [form, setForm] = useState<YoutubeRequest | null>(null);
  const [schedule, setSchedule] = useState(false);
  const [at, setAt] = useState(localInput(24 * 60));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const url = `/api/jobs/${jobId}/clips/${clipId}/youtube`;
  const uploading = upload?.status === 'queued' || upload?.status === 'uploading';

  async function show() {
    setOpen(true);
    setError(null);
    if (info) return;
    try {
      const res = await fetch(url, { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Fel ${res.status}`);
      setInfo(body);
      setForm(body.defaults);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function publish() {
    if (!form) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, publishAt: schedule ? new Date(at).toISOString() : null }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Fel ${res.status}`);
      setOpen(false);
      onStarted?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const set = (patch: Partial<YoutubeRequest>) => setForm((f) => (f ? { ...f, ...patch } : f));

  return (
    <div className="space-y-2">
      {upload && <YoutubeStatus upload={upload} />}
      {!open ? (
        <button
          type="button"
          onClick={show}
          disabled={uploading}
          className="w-full text-center text-xs font-medium bg-base-800 hover:bg-base-700 disabled:opacity-60 rounded-lg py-2 transition-colors"
        >
          {upload?.status === 'done' ? 'Publicera igen på YouTube' : 'Publicera på YouTube'}
        </button>
      ) : (
        <div className="rounded-lg border border-base-700 p-3 space-y-2 text-xs">
          {!info ? (
            <p className="text-gray-400">{error ? '' : 'Laddar ...'}</p>
          ) : !info.account.connected ? (
            <p className="text-gray-300">
              Inget YouTube-konto är kopplat.{' '}
              <Link href="/settings#publicera" className="text-accent-300 underline">
                Koppla ett under Inställningar
              </Link>
              .
            </p>
          ) : (
            form && (
              <>
                <p className="text-gray-400">Till {info.account.channel?.title ?? 'din kanal'}</p>
                <label className="block space-y-1">
                  <span className="text-gray-400">Titel</span>
                  <input
                    value={form.title}
                    maxLength={100}
                    onChange={(e) => set({ title: e.target.value })}
                    className="w-full rounded-md bg-base-800 px-2 py-1.5"
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-gray-400">Beskrivning</span>
                  <textarea
                    value={form.description}
                    rows={4}
                    onChange={(e) => set({ description: e.target.value })}
                    className="w-full rounded-md bg-base-800 px-2 py-1.5"
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-gray-400">Vem kan se den</span>
                  <select
                    value={schedule ? 'private' : form.privacy}
                    disabled={schedule}
                    onChange={(e) => set({ privacy: e.target.value as YoutubePrivacy })}
                    className="w-full rounded-md bg-base-800 px-2 py-1.5"
                  >
                    {(Object.keys(PRIVACY_LABELS) as YoutubePrivacy[]).map((p) => (
                      <option key={p} value={p}>
                        {PRIVACY_LABELS[p]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={schedule} onChange={(e) => setSchedule(e.target.checked)} />
                  <span className="text-gray-300">Schemalägg (privat tills dess, sedan offentlig)</span>
                </label>
                {schedule && (
                  <input
                    type="datetime-local"
                    value={at}
                    min={localInput(10)}
                    onChange={(e) => setAt(e.target.value)}
                    className="w-full rounded-md bg-base-800 px-2 py-1.5"
                  />
                )}
              </>
            )
          )}
          {error && <p className="text-red-300">{error}</p>}
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={() => setOpen(false)} className="rounded-md px-3 py-1.5 hover:bg-base-800">
              Avbryt
            </button>
            {info?.account.connected && (
              <button
                type="button"
                onClick={publish}
                disabled={busy || !form?.title.trim()}
                className="rounded-md bg-accent-500 hover:bg-accent-400 disabled:opacity-50 px-3 py-1.5 font-semibold"
              >
                {busy ? 'Startar ...' : 'Ladda upp'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
