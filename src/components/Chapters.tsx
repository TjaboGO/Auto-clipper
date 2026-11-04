'use client';

import { useState } from 'react';
import { chapterTime, formatChapters } from '@/lib/chapters';
import type { Chapter } from '@/lib/types';

/** "Kapitel": chapters for the whole video, to paste in its YouTube description. */
export function Chapters({
  jobId,
  duration,
  saved,
}: {
  jobId: string;
  duration: number;
  saved?: { items: Chapter[]; at: string };
}) {
  const [chapters, setChapters] = useState<Chapter[] | null>(saved?.items ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function make() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/jobs/${jobId}/chapters`, { method: 'POST' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Fel ${res.status}`);
      setChapters(body.chapters.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function copy() {
    if (!chapters) return;
    navigator.clipboard.writeText(formatChapters(chapters, duration)).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => setError('Kunde inte kopiera kapitlen.'),
    );
  }

  const hours = duration >= 3600;
  return (
    <section className="bg-base-900 rounded-xl2 p-5 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="mr-auto">
          <h2 className="font-semibold">Kapitel för hela videon</h2>
          <p className="text-xs text-gray-400">Klistra in dem i beskrivningen när du lägger upp hela videon på YouTube.</p>
        </div>
        {chapters && (
          <button type="button" onClick={copy} className="rounded-lg bg-accent-500 hover:bg-accent-400 px-3 py-1.5 text-sm font-semibold">
            {copied ? 'Kopierat!' : 'Kopiera'}
          </button>
        )}
        <button
          type="button"
          onClick={make}
          disabled={busy}
          className="rounded-lg bg-base-800 hover:bg-base-700 disabled:opacity-60 px-3 py-1.5 text-sm"
        >
          {busy ? 'Skapar ...' : chapters ? 'Gör om' : 'Skapa kapitel'}
        </button>
      </div>
      {chapters && (
        <ol className="text-sm space-y-1 font-mono">
          {chapters.map((c) => (
            <li key={c.start}>
              <span className="text-accent-300">{chapterTime(c.start, hours)}</span> <span className="font-sans">{c.title}</span>
            </li>
          ))}
        </ol>
      )}
      {error && <p className="text-sm text-red-300">{error}</p>}
    </section>
  );
}
