'use client';

import { useState } from 'react';
import Link from 'next/link';

interface Clip {
  id: string;
  filename: string;
  title: string;
  caption: string;
  hashtags: string[];
  viralityScore: number;
  durationSec: number;
  layout?: string;
  version?: number;
  editable?: boolean;
  renderState?: { status: 'queued' | 'rendering' | 'error'; error?: string };
}

export function ClipCard({ jobId, clip }: { jobId: string; clip: Clip }) {
  const [copied, setCopied] = useState(false);
  const videoSrc = `/api/clips/${jobId}/${clip.filename}`;
  const thumbSrc = `/api/clips/${jobId}/${clip.filename.replace(/\.mp4$/, '.jpg')}`;
  const fullCaption = `${clip.caption}\n\n${clip.hashtags.map((h) => `#${h}`).join(' ')}`;
  const busy = clip.renderState && clip.renderState.status !== 'error';

  function copyCaption() {
    navigator.clipboard.writeText(fullCaption).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      (err) => console.error('Kunde inte kopiera texten:', err),
    );
  }

  return (
    <div className="bg-base-900 rounded-xl2 overflow-hidden flex flex-col">
      <div className="relative bg-black">
        <video
          key={clip.filename}
          src={videoSrc}
          poster={thumbSrc}
          controls
          playsInline
          preload="metadata"
          className="w-full aspect-[9/16] object-contain"
        />
        {busy && (
          <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center gap-2 text-sm">
            <span className="h-6 w-6 rounded-full border-2 border-accent-400 border-t-transparent animate-spin" />
            {clip.renderState?.status === 'queued' ? 'I kö för rendering ...' : 'Renderar den nya versionen ...'}
          </div>
        )}
      </div>
      <div className="p-4 flex-1 flex flex-col gap-3">
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-semibold text-sm leading-snug">{clip.title}</h3>
          <span className="shrink-0 text-xs font-medium px-2 py-1 rounded-full bg-accent-500/20 text-accent-300">
            {clip.viralityScore}
          </span>
        </div>
        {(clip.version ?? 1) > 1 && <p className="text-xs text-gray-500">Redigerad version</p>}
        {clip.renderState?.status === 'error' && (
          <p className="text-xs text-red-300">Renderingen misslyckades: {clip.renderState.error}</p>
        )}
        <p className="text-xs text-gray-400 line-clamp-3">{clip.caption}</p>
        {clip.hashtags.length > 0 && (
          <p className="text-xs text-accent-400">{clip.hashtags.map((h) => `#${h}`).join(' ')}</p>
        )}

        <div className="mt-auto grid grid-cols-2 gap-2 pt-2">
          {clip.editable && (
            <Link
              href={`/jobs/${jobId}/clips/${clip.id}`}
              className="col-span-2 text-center text-xs font-medium bg-base-700 hover:bg-base-800 border border-accent-500/40 rounded-lg py-2 transition-colors"
            >
              Redigera
            </Link>
          )}
          <a
            href={videoSrc}
            download={`${clip.title.replace(/[^a-z0-9]+/gi, '_') || 'klipp'}.mp4`}
            className="text-center text-xs font-medium bg-accent-500 hover:bg-accent-400 rounded-lg py-2 transition-colors"
          >
            Ladda ner
          </a>
          <button
            type="button"
            onClick={copyCaption}
            className="text-center text-xs font-medium bg-base-800 hover:bg-base-700 rounded-lg py-2 transition-colors"
          >
            {copied ? 'Kopierat!' : 'Kopiera text'}
          </button>
        </div>
      </div>
    </div>
  );
}
