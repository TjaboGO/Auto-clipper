'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { JobProgress } from '@/components/JobProgress';
import { ClipCard } from '@/components/ClipCard';

interface Clip {
  id: string;
  filename: string;
  title: string;
  caption: string;
  hashtags: string[];
  viralityScore: number;
  durationSec: number;
}

interface JobData {
  id: string;
  status: string;
  progress: { step: string; message: string; at: string }[];
  clips?: Clip[];
  suggestions?: unknown[];
  error?: string;
  clipCount: number;
  source: { type: string; originalName?: string; url?: string };
}

export default function JobPage() {
  const { id } = useParams<{ id: string }>();
  const [job, setJob] = useState<JobData | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const res = await fetch(`/api/jobs/${id}`, { cache: 'no-store' });
        if (res.status === 404) {
          if (!cancelled) setNotFound(true);
          return;
        }
        const data = await res.json();
        if (cancelled) return;
        setJob(data.job);
        if (data.job.status !== 'done' && data.job.status !== 'error') {
          timer = setTimeout(poll, 2500);
        }
      } catch {
        if (!cancelled) timer = setTimeout(poll, 4000);
      }
    }

    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [id]);

  if (notFound) {
    return (
      <main className="max-w-xl mx-auto px-4 py-24 text-center">
        <p className="text-gray-400">Det här jobbet hittades inte.</p>
        <Link href="/" className="text-accent-400 text-sm mt-4 inline-block">
          &larr; Tillbaka
        </Link>
      </main>
    );
  }

  if (!job) {
    return <main className="max-w-xl mx-auto px-4 py-24 text-center text-gray-400">Laddar ...</main>;
  }

  const isDone = job.status === 'done';
  const isError = job.status === 'error';
  const clips = job.clips ?? [];
  const planned = job.suggestions?.length;

  return (
    <main className="max-w-5xl mx-auto px-4 py-12 md:py-16">
      <Link href="/" className="text-sm text-gray-400 hover:text-white">
        &larr; Ny video
      </Link>

      <h1 className="text-2xl font-bold mt-4 mb-8">
        {isDone
          ? `${clips.length} klipp klara`
          : isError
            ? 'Något gick fel'
            : clips.length > 0 && planned
              ? `Skapar dina klipp ... (${clips.length} av ${planned} klara)`
              : 'Skapar dina klipp ...'}
      </h1>

      {!isDone && <JobProgress steps={job.progress} isError={isError} error={job.error} />}

      {clips.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 mt-8">
          {clips.map((clip) => (
            <ClipCard key={clip.id} jobId={job.id} clip={clip} />
          ))}
        </div>
      )}

      {isDone && clips.length === 0 && (
        <p className="text-gray-400 mt-8">Inga klipp kunde skapas från den här videon.</p>
      )}
    </main>
  );
}
