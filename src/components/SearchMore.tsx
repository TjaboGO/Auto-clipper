'use client';

import { useState, type FormEvent } from 'react';
import { CLIP_LENGTHS, MAX_TOPIC_LENGTH, type ClipLengthId } from '@/lib/jobOptions';

/**
 * "Find more clips" in a finished job: the best moments not clipped yet, or
 * moments about a topic. Runs on the transcript the job already has.
 */
export function SearchMore(props: { jobId: string; defaultLength: ClipLengthId; onStarted: () => void }) {
  const [topic, setTopic] = useState('');
  const [count, setCount] = useState(3);
  const [length, setLength] = useState<ClipLengthId>(props.defaultLength);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSending(true);
    try {
      const res = await fetch(`/api/jobs/${props.jobId}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, clipCount: count, clipLength: length }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? 'Kunde inte starta sökningen.');
      setTopic('');
      props.onStarted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunde inte starta sökningen.');
    } finally {
      setSending(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-10 rounded-xl2 bg-base-900 p-5">
      <h2 className="font-semibold">Hitta fler klipp</h2>
      <p className="text-xs text-gray-400 mt-1 mb-4">
        Söker i samma video igen, så det går fort. Skriv ett ämne, eller lämna tomt för fler bra ögonblick.
      </p>
      <div className="flex flex-col sm:flex-row gap-2">
        <input
          type="text"
          value={topic}
          maxLength={MAX_TOPIC_LENGTH}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="t.ex. när de pratar om pengar"
          aria-label="Ämne"
          className="flex-1 rounded-lg bg-base-950 border border-base-700 px-3 py-2 text-sm focus:outline-none focus:border-accent-500"
        />
        <select
          value={count}
          onChange={(e) => setCount(Number(e.target.value))}
          aria-label="Antal klipp"
          className="rounded-lg bg-base-950 border border-base-700 px-2 py-2 text-sm"
        >
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <option key={n} value={n}>
              {n} klipp
            </option>
          ))}
        </select>
        <select
          value={length}
          onChange={(e) => setLength(e.target.value as ClipLengthId)}
          aria-label="Klipplängd"
          className="rounded-lg bg-base-950 border border-base-700 px-2 py-2 text-sm"
        >
          {CLIP_LENGTHS.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label} ({l.hint})
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={sending}
          className="rounded-lg bg-accent-500 hover:bg-accent-400 disabled:opacity-60 px-4 py-2 text-sm font-semibold"
        >
          {sending ? 'Startar ...' : 'Sök'}
        </button>
      </div>
      {error && <p className="text-red-400 text-sm mt-3">{error}</p>}
    </form>
  );
}
