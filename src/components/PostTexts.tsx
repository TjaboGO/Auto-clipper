'use client';

import { useState } from 'react';
import { POST_PLATFORMS } from '@/lib/chapters';
import type { ClipPosts, PostPlatform } from '@/lib/types';

/** "Inläggstexter": the AI writes the text to post the clip with, per platform, ready to copy. */
export function PostTexts({ jobId, clipId, posts: saved }: { jobId: string; clipId: string; posts?: ClipPosts }) {
  const [open, setOpen] = useState(false);
  const [posts, setPosts] = useState<ClipPosts | undefined>(saved);
  const [platform, setPlatform] = useState<PostPlatform>('tiktok');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function write() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/jobs/${jobId}/clips/${clipId}/posts`, { method: 'POST' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Fel ${res.status}`);
      setPosts(body.posts);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function show() {
    setOpen(true);
    if (!posts && !busy) write();
  }

  function copy() {
    if (!posts) return;
    navigator.clipboard.writeText(posts[platform]).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => setError('Kunde inte kopiera texten.'),
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={show}
        className="w-full text-center text-xs font-medium bg-base-800 hover:bg-base-700 rounded-lg py-2 transition-colors"
        title="Färdiga texter för TikTok, Instagram, YouTube, LinkedIn och X"
      >
        Inläggstexter
      </button>
    );
  }
  const current = POST_PLATFORMS.find((p) => p.id === platform);
  return (
    <div className="rounded-lg border border-base-700 p-2 space-y-2 text-xs">
      <div className="flex flex-wrap gap-1" role="tablist">
        {POST_PLATFORMS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            aria-selected={platform === p.id}
            onClick={() => setPlatform(p.id)}
            className={`rounded-md px-2 py-1 ${platform === p.id ? 'bg-accent-500/20 text-accent-300' : 'bg-base-800 hover:bg-base-700 text-gray-300'}`}
          >
            {p.label}
          </button>
        ))}
      </div>
      {busy && !posts ? (
        <p className="text-gray-400">AI:n skriver ...</p>
      ) : posts ? (
        <>
          <p className="whitespace-pre-wrap text-gray-200 bg-base-800/60 rounded-md p-2 max-h-48 overflow-auto">{posts[platform]}</p>
          <div className="flex items-center gap-2">
            <span className="text-gray-500 mr-auto">
              {[...posts[platform]].length}
              {current && current.max < 1000 ? ` / ${current.max}` : ''} tecken
            </span>
            <button type="button" onClick={write} disabled={busy} className="rounded-md px-2 py-1 hover:bg-base-800 disabled:opacity-50">
              {busy ? 'Skriver ...' : 'Skriv nya'}
            </button>
            <button type="button" onClick={copy} className="rounded-md px-2 py-1 bg-accent-500 hover:bg-accent-400 font-semibold">
              {copied ? 'Kopierat!' : 'Kopiera'}
            </button>
          </div>
        </>
      ) : null}
      {error && <p className="text-red-300">{error}</p>}
      <button type="button" onClick={() => setOpen(false)} className="w-full text-gray-500 hover:text-white">
        Stäng
      </button>
    </div>
  );
}
