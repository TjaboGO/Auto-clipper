'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';

type Mode = 'upload' | 'youtube';

export function UploadForm() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState('');
  const [clipCount, setClipCount] = useState(6);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

    setSubmitting(true);
    try {
      let res: Response;
      if (mode === 'upload' && file) {
        const form = new FormData();
        form.append('file', file);
        form.append('clipCount', String(clipCount));
        res = await fetch('/api/jobs', { method: 'POST', body: form });
      } else {
        res = await fetch('/api/jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ youtubeUrl: url.trim(), clipCount }),
        });
      }

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Något gick fel.');
      router.push(`/jobs/${data.jobId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Något gick fel.');
      setSubmitting(false);
    }
  }

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

      <div className="flex items-center justify-between mt-6 mb-6">
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

      {error && <p className="text-red-400 text-sm mb-4">{error}</p>}

      <button
        type="submit"
        disabled={submitting}
        className="w-full rounded-xl2 bg-accent-500 hover:bg-accent-400 disabled:opacity-50 disabled:cursor-not-allowed py-4 font-medium transition-colors"
      >
        {submitting ? 'Startar ...' : 'Skapa klipp'}
      </button>
    </form>
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
