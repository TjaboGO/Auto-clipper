'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { LogoutButton } from '@/components/LogoutButton';
import { YoutubeStatus } from '@/components/YoutubePublish';
import { PRIVACY_LABELS } from '@/lib/youtubeMeta';
import type { YoutubeUpload } from '@/lib/types';

interface Entry {
  jobId: string;
  clipId: string;
  clipTitle: string;
  thumb: string;
  durationSec: number;
  upload: YoutubeUpload;
}

/** When it goes (or went) out: the publish time if it's scheduled, else when it was uploaded. */
const when = (e: Entry) => Date.parse(e.upload.publishAt ?? e.upload.at);

function dayLabel(time: number): string {
  const day = new Date(time);
  const today = new Date();
  const diff = Math.round((new Date(day.toDateString()).getTime() - new Date(today.toDateString()).getTime()) / 86_400_000);
  if (diff === 0) return 'I dag';
  if (diff === 1) return 'I morgon';
  if (diff === -1) return 'I går';
  return day.toLocaleDateString('sv-SE', { weekday: 'long', day: 'numeric', month: 'long' });
}

function groupByDay(entries: Entry[]): [string, Entry[]][] {
  const groups = new Map<string, Entry[]>();
  for (const e of entries) {
    const key = dayLabel(when(e));
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  return [...groups];
}

function Row({ entry }: { entry: Entry }) {
  const { upload } = entry;
  const time = new Date(when(entry)).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
  return (
    <li className="flex gap-3 items-center bg-base-900 rounded-lg p-2">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={entry.thumb} alt="" className="h-16 w-9 object-cover rounded bg-black shrink-0" />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium truncate">{upload.title}</p>
        <p className="text-xs text-gray-500">
          {time} · {PRIVACY_LABELS[upload.privacy]}
          {upload.publishAt ? ' till publicering' : ''} ·{' '}
          <Link href={`/jobs/${entry.jobId}`} className="hover:text-white underline">
            Jobbet
          </Link>
        </p>
        <YoutubeStatus upload={upload} />
      </div>
    </li>
  );
}

export default function CalendarPage() {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch('/api/youtube/uploads', { cache: 'no-store' });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || `Fel ${res.status}`);
        if (cancelled) return;
        setEntries(body.uploads);
        // Keep up with uploads that are running.
        if (body.uploads.some((e: Entry) => e.upload.status === 'queued' || e.upload.status === 'uploading')) {
          timer = setTimeout(load, 3000);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    }
    load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  const now = Date.now();
  const all = entries ?? [];
  const running = all.filter((e) => e.upload.status === 'queued' || e.upload.status === 'uploading' || e.upload.status === 'error');
  const coming = all.filter((e) => e.upload.status === 'done' && e.upload.publishAt && when(e) > now).sort((a, b) => when(a) - when(b));
  const out = all.filter((e) => e.upload.status === 'done' && !(e.upload.publishAt && when(e) > now)).sort((a, b) => when(b) - when(a));

  return (
    <main className="max-w-3xl mx-auto px-4 py-12 md:py-16 space-y-8">
      <div>
        <div className="flex items-center justify-between">
          <Link href="/" className="text-sm text-gray-400 hover:text-white">
            &larr; Ny video
          </Link>
          <LogoutButton />
        </div>
        <h1 className="text-2xl font-bold mt-4">Kalender</h1>
        <p className="text-sm text-gray-400 mt-1">
          Klipp du schemalagt eller publicerat på YouTube. Du schemalägger från varje klipp med &quot;Publicera på
          YouTube&quot;.
        </p>
      </div>
      {error && <p className="rounded-md px-3 py-2 text-sm bg-red-500/15 text-red-200">{error}</p>}
      {entries && all.length === 0 && (
        <p className="text-sm text-gray-400">
          Inget publicerat än.{' '}
          <Link href="/settings#publicera" className="text-accent-300 underline">
            Koppla YouTube
          </Link>{' '}
          och publicera ett klipp, så syns det här.
        </p>
      )}
      {running.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-gray-300">Pågår och misslyckade</h2>
          <ul className="space-y-2">
            {running.map((e) => (
              <Row key={`${e.jobId}/${e.clipId}/${e.upload.at}`} entry={e} />
            ))}
          </ul>
        </section>
      )}
      {coming.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-lg font-semibold">Kommande</h2>
          {groupByDay(coming).map(([day, list]) => (
            <div key={day} className="space-y-2">
              <h3 className="text-sm text-gray-400 first-letter:uppercase">{day}</h3>
              <ul className="space-y-2">
                {list.map((e) => (
                  <Row key={`${e.jobId}/${e.clipId}/${e.upload.at}`} entry={e} />
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}
      {out.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-lg font-semibold">Publicerade</h2>
          {groupByDay(out).map(([day, list]) => (
            <div key={day} className="space-y-2">
              <h3 className="text-sm text-gray-400 first-letter:uppercase">{day}</h3>
              <ul className="space-y-2">
                {list.map((e) => (
                  <Row key={`${e.jobId}/${e.clipId}/${e.upload.at}`} entry={e} />
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}
    </main>
  );
}
