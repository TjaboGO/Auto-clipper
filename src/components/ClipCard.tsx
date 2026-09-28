'use client';

import { useState } from 'react';

interface Clip {
  id: string;
  filename: string;
  title: string;
  caption: string;
  hashtags: string[];
  viralityScore: number;
  durationSec: number;
}

export function ClipCard({ jobId, clip }: { jobId: string; clip: Clip }) {
  const [copied, setCopied] = useState(false);
  const videoSrc = `/api/clips/${jobId}/${clip.filename}`;
  const thumbSrc = `/api/clips/${jobId}/${clip.filename.replace(/\.mp4$/, '.jpg')}`;
  const fullCaption = `${clip.caption}\n\n${clip.hashtags.map((h) => `#${h}`).join(' ')}`;

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
      <video
        src={videoSrc}
        poster={thumbSrc}
        controls
        playsInline
        preload="metadata"
        className="w-full aspect-[9/16] bg-black object-contain"
      />
      <div className="p-4 flex-1 flex flex-col gap-3">
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-semibold text-sm leading-snug">{clip.title}</h3>
          <span className="shrink-0 text-xs font-medium px-2 py-1 rounded-full bg-accent-500/20 text-accent-300">
            {clip.viralityScore}
          </span>
        </div>
        <p className="text-xs text-gray-400 line-clamp-3">{clip.caption}</p>
        {clip.hashtags.length > 0 && (
          <p className="text-xs text-accent-400">{clip.hashtags.map((h) => `#${h}`).join(' ')}</p>
        )}

        <div className="mt-auto flex gap-2 pt-2">
          <a
            href={videoSrc}
            download={`${clip.title.replace(/[^a-z0-9]+/gi, '_') || 'klipp'}.mp4`}
            className="flex-1 text-center text-xs font-medium bg-accent-500 hover:bg-accent-400 rounded-lg py-2 transition-colors"
          >
            Ladda ner
          </a>
          <button
            type="button"
            onClick={copyCaption}
            className="flex-1 text-center text-xs font-medium bg-base-800 hover:bg-base-700 rounded-lg py-2 transition-colors"
          >
            {copied ? 'Kopierat!' : 'Kopiera text'}
          </button>
        </div>
      </div>
    </div>
  );
}
