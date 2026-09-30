'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { JobProgress } from '@/components/JobProgress';
import { ClipCard } from '@/components/ClipCard';
import { SearchMore } from '@/components/SearchMore';
import { captionPreset } from '@/lib/edit/presets';
import { clipLength, formatClock, type JobOptions } from '@/lib/jobOptions';

interface Clip {
  id: string;
  filename: string;
  title: string;
  caption: string;
  hashtags: string[];
  viralityScore: number;
  durationSec: number;
  version?: number;
  editable?: boolean;
  renderState?: { status: 'queued' | 'rendering' | 'error'; error?: string };
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
  sourceAvailable?: boolean;
  sourceRetentionDays?: number;
  options?: JobOptions;
  canSearch?: boolean;
  watched?: boolean;
  finishedAt?: string;
  lastSearch?: { topic: string; at: string; added: number; message: string };
}

/** What was chosen for the job (and whether Gemini watched it), as short labels. */
function optionLabels(options?: JobOptions, watched?: boolean): string[] {
  if (!options) return watched ? ['Tittade på bilden'] : [];
  return [
    watched ? 'Tittade på bilden' : '',
    options.topic ? `Om: ${options.topic}` : '',
    options.clipLength === 'auto' ? '' : clipLength(options.clipLength).hint,
    options.aspect,
    captionPreset(options.captionPreset).label,
    options.keywords ? 'Nyckelord' : '',
    options.range ? `Del ${formatClock(options.range.start)}-${formatClock(options.range.end)}` : '',
  ].filter(Boolean);
}

const rendering = (job: JobData) =>
  job.clips?.some((c) => c.renderState && c.renderState.status !== 'error') ?? false;

export default function JobPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [job, setJob] = useState<JobData | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Bumped to start polling again (after starting a search for more clips).
  const [pollKey, setPollKey] = useState(0);

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
        // Keep polling while the job runs, or while a clip is rendered again.
        if ((data.job.status !== 'done' && data.job.status !== 'error') || rendering(data.job)) {
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
  }, [id, pollKey]);

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
  // A search for more clips in a job that already finished.
  const searching = !!job.finishedAt && !isDone && !isError;
  const labels = optionLabels(job.options, job.watched);

  async function deleteJob() {
    if (!window.confirm('Ta bort jobbet med alla klipp och källvideon? Det går inte att ångra.')) return;
    setDeleting(true);
    const res = await fetch(`/api/jobs/${id}`, { method: 'DELETE' });
    if (res.ok) {
      router.push('/');
    } else {
      setDeleting(false);
      const body = await res.json().catch(() => ({}));
      window.alert(body.error ?? 'Kunde inte ta bort jobbet.');
    }
  }

  return (
    <main className="max-w-5xl mx-auto px-4 py-12 md:py-16">
      <Link href="/" className="text-sm text-gray-400 hover:text-white">
        &larr; Ny video
      </Link>

      <h1 className={`text-2xl font-bold mt-4 ${labels.length ? 'mb-3' : 'mb-8'}`}>
        {isDone
          ? `${clips.length} klipp klara`
          : isError
            ? 'Något gick fel'
            : searching
              ? 'Letar efter fler klipp ...'
              : clips.length > 0 && planned
                ? `Skapar dina klipp ... (${clips.length} av ${planned} klara)`
                : 'Skapar dina klipp ...'}
      </h1>
      {labels.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-8">
          {labels.map((label) => (
            <span key={label} className="text-xs rounded-full bg-base-800 text-gray-300 px-2.5 py-1">
              {label}
            </span>
          ))}
        </div>
      )}

      {isDone && job.lastSearch && (
        <p className={`mb-6 rounded-lg px-4 py-2 text-sm ${job.lastSearch.added > 0 ? 'bg-accent-500/15 text-accent-300' : 'bg-base-800 text-gray-300'}`}>
          {job.lastSearch.message}
        </p>
      )}

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

      {isDone && job.canSearch && (
        <SearchMore
          jobId={job.id}
          defaultLength={job.options?.clipLength ?? 'auto'}
          canWatch={!job.watched}
          onStarted={() => setPollKey((k) => k + 1)}
        />
      )}

      {(isDone || isError) && (
        <div className="mt-10 flex flex-wrap items-center justify-between gap-3 text-xs text-gray-500">
          <p>
            {job.sourceAvailable && clips.length > 0
              ? `Källvideon sparas i ${job.sourceRetentionDays} dagar efter senaste ändringen, så klippen går att redigera.`
              : clips.length > 0
                ? 'Källvideon är borttagen, så klippen kan inte redigeras längre.'
                : ''}
          </p>
          <button
            type="button"
            onClick={deleteJob}
            disabled={deleting || rendering(job)}
            className="rounded-lg border border-red-500/30 px-3 py-1.5 text-red-300 hover:bg-red-500/10 disabled:opacity-40"
          >
            {deleting ? 'Tar bort ...' : 'Ta bort jobbet'}
          </button>
        </div>
      )}
    </main>
  );
}
