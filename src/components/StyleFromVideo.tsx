'use client';

import { useEffect, useRef, useState } from 'react';
import { FileButton } from './FileButton';
import { fetchStyleJob, startStyleFromVideo, type StyleJob } from './brandApi';

/**
 * "Skapa mall från en video": a link or a file of a video whose editing you
 * like. Gemini watches and listens to it, and the app saves its style as a
 * template, with notes on what to do by hand or what the app can't do yet.
 */
export function StyleFromVideo({ onDone }: { onDone: () => void }) {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [job, setJob] = useState<StyleJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  function follow(next: StyleJob) {
    setJob(next);
    if (next.status === 'working') {
      timer.current = setTimeout(async () => {
        try {
          follow(await fetchStyleJob(next.id));
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }, 2000);
    } else if (next.status === 'done') {
      onDone();
    }
  }

  async function start(input: { url?: string; file?: File }) {
    setError(null);
    setJob({ id: '', status: 'working', step: input.file ? 'Laddar upp videon ...' : 'Startar ...' });
    try {
      follow(await startStyleFromVideo({ ...input, name: name.trim() || undefined }));
    } catch (err) {
      setJob(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const working = job?.status === 'working';
  return (
    <div className="space-y-3 rounded-lg border border-base-700 p-3">
      <div>
        <h3 className="text-sm font-semibold">Skapa mall från en video</h3>
        <p className="text-xs text-gray-400">
          En video vars redigering du gillar, till exempel från TikTok, YouTube Shorts eller Reels. Gemini tittar och
          lyssnar på den (de första tre minuterna) och gör en mall av stilen: text, tempo, zoom, övergångar och mer.
        </p>
      </div>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (url.trim()) start({ url: url.trim() });
        }}
      >
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Länk till videon"
          aria-label="Länk till videon"
          disabled={working}
          className="min-w-0 flex-1 rounded-lg bg-base-800 px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={working || !url.trim()}
          className="rounded-lg bg-accent-500 hover:bg-accent-400 disabled:opacity-50 px-4 py-2 text-sm font-semibold"
        >
          Gör mall
        </button>
      </form>
      <div className="flex flex-wrap items-center gap-2">
        <FileButton accept="video/*" busy={working} onFile={(file) => start({ file })}>
          Eller välj en videofil
        </FileButton>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={40}
          placeholder="Namn (valfritt)"
          aria-label="Mallens namn"
          disabled={working}
          className="min-w-0 flex-1 rounded-lg bg-base-800 px-3 py-1.5 text-sm"
        />
      </div>
      {working && (
        <p className="text-sm text-gray-300 flex items-center gap-2" role="status">
          <span className="h-3.5 w-3.5 rounded-full border-2 border-accent-400 border-t-transparent animate-spin" />
          {job?.step}
        </p>
      )}
      {job?.status === 'error' && <p className="text-sm text-red-300">Det gick inte: {job.error}</p>}
      {error && <p className="text-sm text-red-300">{error}</p>}
      {job?.status === 'done' && job.template && (
        <div className="rounded-md bg-accent-500/10 px-3 py-2 text-sm space-y-1.5" role="status">
          <p className="text-accent-300 font-medium">Mallen {job.template.name} är sparad.</p>
          {job.template.origin?.summary && <p className="text-gray-300">{job.template.origin.summary}</p>}
          {job.template.origin?.notes.length ? (
            <ul className="list-disc pl-5 text-xs text-gray-400 space-y-0.5">
              {job.template.origin.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </div>
  );
}
