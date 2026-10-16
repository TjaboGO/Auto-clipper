'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';

/** Only paths inside the app: never send someone on to another site after logging in. */
function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

export function LoginForm() {
  const params = useSearchParams();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? 'Kunde inte logga in.');
        setBusy(false);
        return;
      }
      window.location.assign(safeNext(params.get('next')));
    } catch {
      setError('Kunde inte nå servern.');
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="w-full max-w-sm rounded-2xl bg-base-900/70 p-6 space-y-4">
      <div>
        <h1 className="text-2xl font-bold">
          Auto <span className="text-accent-400">Clipper</span>
        </h1>
        <p className="mt-1 text-sm text-gray-400">Skriv lösenordet för att komma in.</p>
      </div>
      <label className="block space-y-1.5">
        <span className="text-sm text-gray-300">Lösenord</span>
        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-lg bg-base-800 px-3 py-2 outline-none focus:ring-2 focus:ring-accent-500"
        />
      </label>
      {error && (
        <p role="alert" className="rounded-md bg-red-500/15 px-3 py-2 text-sm text-red-200">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={busy || !password}
        className="w-full rounded-lg bg-accent-500 py-2 font-semibold hover:bg-accent-400 disabled:opacity-50"
      >
        {busy ? 'Loggar in ...' : 'Logga in'}
      </button>
    </form>
  );
}
