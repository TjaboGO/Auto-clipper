'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ClipEditor } from '@/components/editor/ClipEditor';
import type { EditorPayload } from '@/components/editor/types';
import { previewFormat } from '@/components/editor/previewFormat';

export default function ClipEditorPage() {
  const { id, clipId } = useParams<{ id: string; clipId: string }>();
  const [payload, setPayload] = useState<EditorPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPayload(null);
    setError(null);
    fetch(`/api/jobs/${id}/clips/${clipId}/editor?format=${previewFormat()}`, { cache: 'no-store' })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) setError(body.error ?? 'Kunde inte öppna klippet.');
        else setPayload(body as EditorPayload);
      })
      .catch(() => !cancelled && setError('Kunde inte nå servern.'));
    return () => {
      cancelled = true;
    };
  }, [id, clipId]);

  if (error) {
    return (
      <main className="max-w-xl mx-auto px-4 py-24 text-center">
        <p className="text-gray-300">{error}</p>
        <Link href={`/jobs/${id}`} className="text-accent-400 text-sm mt-4 inline-block">
          &larr; Tillbaka till klippen
        </Link>
      </main>
    );
  }
  if (!payload) {
    return <main className="max-w-xl mx-auto px-4 py-24 text-center text-gray-400">Öppnar redigeraren ...</main>;
  }
  // A new key per clip, so moving to the next clip starts fresh.
  return <ClipEditor key={clipId} initial={payload} />;
}
