'use client';

import { useEffect, useState } from 'react';

/** "Logga ut", shown only when the app has a password. */
export function LogoutButton({ className = '' }: { className?: string }) {
  const [auth, setAuth] = useState(false);
  useEffect(() => {
    fetch('/api/session', { cache: 'no-store' })
      .then((r) => r.json())
      .then((s) => setAuth(!!s.auth))
      .catch(() => undefined);
  }, []);
  if (!auth) return null;
  const logout = async () => {
    await fetch('/api/logout', { method: 'POST' }).catch(() => undefined);
    window.location.assign('/login');
  };
  return (
    <button type="button" onClick={logout} className={`text-sm text-gray-400 hover:text-white ${className}`}>
      Logga ut
    </button>
  );
}
