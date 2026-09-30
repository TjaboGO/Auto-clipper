'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface JobSummary {
  id: string;
  status: string;
  createdAt: string;
  source: { type: string; originalName?: string; url?: string };
  clipsReady: number;
}

const STATUS_LABELS: Record<string, string> = {
  queued: 'I kö',
  downloading: 'Laddar ner',
  transcribing: 'Transkriberar',
  analyzing: 'Analyserar',
  rendering: 'Renderar',
  done: 'Klar',
  error: 'Fel',
};

/** The latest jobs, so you can get back to one after closing its tab. */
export function RecentJobs() {
  const [jobs, setJobs] = useState<JobSummary[]>([]);

  useEffect(() => {
    fetch('/api/jobs', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : { jobs: [] }))
      .then((data) => setJobs((data.jobs ?? []).slice(0, 8)))
      .catch(() => setJobs([]));
  }, []);

  if (jobs.length === 0) return null;

  return (
    <section className="w-full max-w-xl mx-auto mt-16">
      <h2 className="text-sm font-medium text-gray-400 mb-3">Senaste jobb</h2>
      <ul className="divide-y divide-base-800 bg-base-900 rounded-xl2 overflow-hidden">
        {jobs.map((job) => (
          <li key={job.id}>
            <Link
              href={`/jobs/${job.id}`}
              className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-base-800 transition-colors"
            >
              <div className="min-w-0">
                <p className="text-sm truncate">
                  {job.source.type === 'upload' ? job.source.originalName : job.source.url}
                </p>
                <p className="text-xs text-gray-500">
                  {new Date(job.createdAt).toLocaleString('sv-SE', {
                    dateStyle: 'short',
                    timeStyle: 'short',
                  })}
                  {job.clipsReady > 0 && ` · ${job.clipsReady} klipp`}
                </p>
              </div>
              <span
                className={`shrink-0 text-xs font-medium px-2 py-1 rounded-full ${
                  job.status === 'done'
                    ? 'bg-accent-500/20 text-accent-300'
                    : job.status === 'error'
                      ? 'bg-red-500/15 text-red-300'
                      : 'bg-base-800 text-gray-300'
                }`}
              >
                {STATUS_LABELS[job.status] ?? job.status}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
