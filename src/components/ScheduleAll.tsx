'use client';

import { useState } from 'react';
import Link from 'next/link';

interface ClipRow {
  id: string;
  title: string;
  viralityScore: number;
  youtube?: { status: string };
}

const INTERVALS: { hours: number; label: string }[] = [
  { hours: 6, label: 'Var 6:e timme' },
  { hours: 12, label: 'Var 12:e timme' },
  { hours: 24, label: 'En om dagen' },
  { hours: 48, label: 'Varannan dag' },
  { hours: 168, label: 'En i veckan' },
];

/** Tomorrow at 18:00, as a datetime-local value. */
function tomorrowEvening(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(18, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "Schemalägg alla på YouTube": the job's clips out one by one, best first, at even intervals. */
export function ScheduleAll({ jobId, clips, onStarted }: { jobId: string; clips: ClipRow[]; onStarted: () => void }) {
  const [open, setOpen] = useState(false);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [first, setFirst] = useState(tomorrowEvening());
  const [every, setEvery] = useState(24);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const best = [...clips].sort((a, b) => b.viralityScore - a.viralityScore);

  async function show() {
    setOpen(true);
    setMessage(null);
    // Best first, and not the ones that are already out or on their way.
    setPicked(best.filter((c) => !c.youtube || c.youtube.status === 'error').map((c) => c.id));
    try {
      const res = await fetch('/api/youtube', { cache: 'no-store' });
      setConnected(!!(await res.json()).account?.connected);
    } catch {
      setConnected(false);
    }
  }

  async function schedule() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/jobs/${jobId}/youtube`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clipIds: best.filter((c) => picked.includes(c.id)).map((c) => c.id), firstAt: new Date(first).toISOString(), everyHours: every }),
      });
      const body = await res.json();
      if (!res.ok && !body.skipped) throw new Error(body.error || `Fel ${res.status}`);
      const skipped: { title: string; reason: string }[] = body.skipped ?? [];
      setMessage({
        text:
          `${body.scheduled?.length ?? 0} klipp laddas upp och schemaläggs.` +
          (skipped.length ? ` Hoppade över: ${skipped.map((s) => `${s.title} (${s.reason})`).join(', ')}` : ''),
        error: !body.scheduled?.length,
      });
      if (body.scheduled?.length) onStarted();
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : String(err), error: true });
    } finally {
      setBusy(false);
    }
  }

  const times = best
    .filter((c) => picked.includes(c.id))
    .map((c, i) => ({ clip: c, at: new Date(new Date(first).getTime() + i * every * 3600_000) }));

  if (!open) {
    return (
      <button type="button" onClick={show} className="rounded-lg bg-base-800 hover:bg-base-700 px-4 py-2 text-sm">
        Schemalägg på YouTube
      </button>
    );
  }
  return (
    <section className="w-full bg-base-900 rounded-xl2 p-5 space-y-3 text-sm">
      <div className="flex items-center">
        <h2 className="font-semibold mr-auto">Schemalägg på YouTube</h2>
        <button type="button" onClick={() => setOpen(false)} className="text-gray-400 hover:text-white" aria-label="Stäng">
          ✕
        </button>
      </div>
      {connected === false ? (
        <p className="text-gray-300">
          Inget YouTube-konto är kopplat.{' '}
          <Link href="/settings#publicera" className="text-accent-300 underline">
            Koppla ett under Inställningar
          </Link>
          .
        </p>
      ) : (
        <>
          <p className="text-gray-400">
            Bästa klippet först. Varje klipp får sin föreslagna titel, text och hashtags, och är privat tills det publiceras.
          </p>
          <div className="flex flex-wrap gap-3">
            <label className="space-y-1">
              <span className="block text-xs text-gray-400">Första klippet</span>
              <input type="datetime-local" value={first} onChange={(e) => setFirst(e.target.value)} className="rounded-md bg-base-800 px-2 py-1.5" />
            </label>
            <label className="space-y-1">
              <span className="block text-xs text-gray-400">Sedan</span>
              <select value={every} onChange={(e) => setEvery(Number(e.target.value))} className="rounded-md bg-base-800 px-2 py-1.5">
                {INTERVALS.map((i) => (
                  <option key={i.hours} value={i.hours}>
                    {i.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <ul className="space-y-1">
            {best.map((c) => {
              const slot = times.find((t) => t.clip.id === c.id);
              return (
                <li key={c.id}>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={picked.includes(c.id)}
                      onChange={(e) => setPicked((p) => (e.target.checked ? [...p, c.id] : p.filter((x) => x !== c.id)))}
                    />
                    <span className="truncate mr-auto">{c.title}</span>
                    <span className="text-xs text-gray-400 shrink-0">
                      {slot
                        ? slot.at.toLocaleString('sv-SE', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
                        : c.youtube && c.youtube.status !== 'error'
                          ? 'redan uppladdad'
                          : ''}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            onClick={schedule}
            disabled={busy || picked.length === 0 || connected === null}
            className="rounded-lg bg-accent-500 hover:bg-accent-400 disabled:opacity-50 px-4 py-2 font-semibold"
          >
            {busy ? 'Schemalägger ...' : `Schemalägg ${picked.length} klipp`}
          </button>
        </>
      )}
      {message && <p className={message.error ? 'text-red-300' : 'text-accent-300'}>{message.text}</p>}
    </section>
  );
}
