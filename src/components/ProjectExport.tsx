'use client';

import { useEffect, useRef, useState } from 'react';

interface ProjectState {
  status: 'none' | 'queued' | 'building' | 'ready' | 'error';
  step?: string;
  error?: string;
  bytes?: number;
}

function megabytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

/**
 * "Exportera till Premiere / DaVinci": builds the clip as a project (the
 * timeline and its media) on the server, then downloads it as a ZIP.
 */
export function ProjectExport({ jobId, clipId, version, className = '' }: { jobId: string; clipId: string; version?: number; className?: string }) {
  const [state, setState] = useState<ProjectState>({ status: 'none' });
  const [asked, setAsked] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const url = `/api/jobs/${jobId}/clips/${clipId}/project`;

  // A new version of the clip needs a new project.
  useEffect(() => {
    setState({ status: 'none' });
    setAsked(false);
  }, [version]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  function follow(next: ProjectState, download: boolean) {
    setState(next);
    if (timer.current) clearTimeout(timer.current);
    if (next.status === 'queued' || next.status === 'building') {
      timer.current = setTimeout(async () => {
        try {
          const res = await fetch(`${url}?status`, { cache: 'no-store' });
          follow((await res.json()) as ProjectState, download);
        } catch {
          follow(next, download);
        }
      }, 2000);
    } else if (next.status === 'ready' && download) {
      window.location.href = url;
    }
  }

  async function start() {
    setAsked(true);
    try {
      const res = await fetch(url, { method: 'POST' });
      const body = (await res.json()) as ProjectState & { error?: string };
      if (!res.ok) throw new Error(body.error || `Fel ${res.status}`);
      follow(body, true);
    } catch (err) {
      setState({ status: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  }

  const busy = state.status === 'queued' || state.status === 'building';
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      {state.status === 'ready' ? (
        <a href={url} className="text-center text-xs font-medium bg-base-800 hover:bg-base-700 rounded-lg py-2 transition-colors">
          Ladda ner projektet ({megabytes(state.bytes ?? 0)})
        </a>
      ) : (
        <button
          type="button"
          onClick={start}
          disabled={busy}
          title="En ZIP med tidslinjen (XML), videon, texterna som eget lager, B-roll och musik"
          className="text-center text-xs font-medium bg-base-800 hover:bg-base-700 disabled:opacity-60 rounded-lg py-2 transition-colors"
        >
          {busy ? (state.status === 'queued' ? 'I kö ...' : state.step || 'Bygger projektet ...') : 'Exportera till Premiere / DaVinci'}
        </button>
      )}
      {busy && <p className="text-[11px] text-gray-500 text-center">Det tar ungefär lika lång tid som en rendering.</p>}
      {asked && state.status === 'error' && <p className="text-xs text-red-300">Exporten misslyckades: {state.error}</p>}
    </div>
  );
}
