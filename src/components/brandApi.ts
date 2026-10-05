// The browser side of the brand kit API (fonts, logo, "Min stil") and the
// YouTube cookies, shared by the editor and the settings page.
import type { CustomFont } from '@/lib/edit/fonts';
import type { BrandInfo, BrandStyle } from '@/lib/edit/types';

export interface CookieStatus {
  present: boolean;
  fromEnv: boolean;
  updatedAt?: string;
  youtube?: number;
  signedIn?: boolean;
  expired?: boolean;
}

async function call<T>(url: string, init: RequestInit, fallbackError: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new Error('Kunde inte nå servern.');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? fallbackError);
  return body as T;
}

export const fetchBrand = () =>
  call<{ brand: BrandInfo }>('/api/brand', { cache: 'no-store' }, 'Kunde inte läsa varumärkesinställningarna.').then(
    (b) => b.brand,
  );

export const uploadFont = (file: File) =>
  call<{ font: CustomFont; brand: BrandInfo }>(
    `/api/brand/fonts?filename=${encodeURIComponent(file.name)}`,
    { method: 'POST', body: file },
    'Kunde inte ladda upp typsnittet.',
  );

export const deleteFont = (id: string) =>
  call<{ brand: BrandInfo }>(`/api/brand/fonts/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'Kunde inte ta bort typsnittet.').then(
    (b) => b.brand,
  );

export const uploadLogo = (file: File) =>
  call<{ brand: BrandInfo }>('/api/brand/logo', { method: 'POST', body: file }, 'Kunde inte ladda upp loggan.').then(
    (b) => b.brand,
  );

export const deleteLogo = () =>
  call<{ brand: BrandInfo }>('/api/brand/logo', { method: 'DELETE' }, 'Kunde inte ta bort loggan.').then((b) => b.brand);

export const saveStyle = (style: Omit<BrandStyle, 'savedAt'>) =>
  call<{ brand: BrandInfo }>(
    '/api/brand/style',
    { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(style) },
    'Kunde inte spara stilen.',
  ).then((b) => b.brand);

export const clearStyle = () =>
  call<{ brand: BrandInfo }>('/api/brand/style', { method: 'DELETE' }, 'Kunde inte ta bort stilen.').then((b) => b.brand);

export const logoUrl = (version: string) => `/api/brand/logo?v=${encodeURIComponent(version)}`;

export const fetchCookies = () =>
  call<{ cookies: CookieStatus }>('/api/youtube-cookies', { cache: 'no-store' }, 'Kunde inte läsa cookie-inställningen.').then(
    (b) => b.cookies,
  );

export const saveCookies = (text: string) =>
  call<{ cookies: CookieStatus }>('/api/youtube-cookies', { method: 'PUT', body: text }, 'Kunde inte spara cookies.').then(
    (b) => b.cookies,
  );

export const deleteCookies = () =>
  call<{ cookies: CookieStatus }>('/api/youtube-cookies', { method: 'DELETE' }, 'Kunde inte ta bort cookies.').then(
    (b) => b.cookies,
  );
