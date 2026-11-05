// The browser side of the brand kit API (fonts, logo, "Min stil") and the
// YouTube cookies, shared by the editor and the settings page.
import type { CustomFont } from '@/lib/edit/fonts';
import type { BrandInfo, BrandStyle, BrollVideo, MusicTrack } from '@/lib/edit/types';

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

export const uploadMusic = (file: File) =>
  call<{ track: MusicTrack; brand: BrandInfo }>(
    `/api/brand/music?filename=${encodeURIComponent(file.name)}`,
    { method: 'POST', body: file },
    'Kunde inte ladda upp låten.',
  );

export const deleteMusic = (id: string) =>
  call<{ brand: BrandInfo }>(`/api/brand/music/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'Kunde inte ta bort låten.').then(
    (b) => b.brand,
  );

export const musicUrl = (id: string) => `/api/brand/music/${encodeURIComponent(id)}`;

export interface PexelsStatus {
  configured: boolean;
  fromEnv: boolean;
}

export const fetchPexels = () =>
  call<{ pexels: PexelsStatus }>('/api/pexels', { cache: 'no-store' }, 'Kunde inte läsa Pexels-inställningen.').then((b) => b.pexels);

export const savePexelsKey = (key: string) =>
  call<{ pexels: PexelsStatus }>(
    '/api/pexels',
    { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) },
    'Kunde inte spara nyckeln.',
  ).then((b) => b.pexels);

export const deletePexelsKey = () =>
  call<{ pexels: PexelsStatus }>('/api/pexels', { method: 'DELETE' }, 'Kunde inte ta bort nyckeln.').then((b) => b.pexels);

export const searchBroll = (q: string, orientation: string) =>
  call<{ videos: BrollVideo[] }>(
    `/api/broll/search?q=${encodeURIComponent(q)}&orientation=${orientation}`,
    { cache: 'no-store' },
    'Sökningen på Pexels misslyckades.',
  ).then((b) => b.videos);

export const downloadBroll = (video: BrollVideo) =>
  call<{ video: BrollVideo }>(
    '/api/broll/download',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ video }) },
    'Kunde inte hämta videon.',
  ).then((b) => b.video);

export const brollUrl = (file: string) => `/api/broll/${encodeURIComponent(file)}`;

export interface YoutubeSettings {
  app: { configured: boolean; fromEnv: boolean; clientId?: string };
  account: { connected: boolean; channel?: { id: string; title: string; thumb?: string }; connectedAt?: string };
  /** The address to add in the Google app. */
  redirectUri: string;
}

export const fetchYoutube = () => call<YoutubeSettings>('/api/youtube', { cache: 'no-store' }, 'Kunde inte läsa YouTube-inställningen.');

export const saveYoutubeApp = (clientId: string, clientSecret: string) =>
  call<{ app: YoutubeSettings['app'] }>(
    '/api/youtube/app',
    { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId, clientSecret }) },
    'Kunde inte spara Google-appen.',
  ).then((b) => b.app);

export const deleteYoutubeApp = () =>
  call<{ app: YoutubeSettings['app'] }>('/api/youtube/app', { method: 'DELETE' }, 'Kunde inte ta bort Google-appen.').then((b) => b.app);

export const disconnectYoutube = () =>
  call<{ account: YoutubeSettings['account'] }>('/api/youtube/account', { method: 'DELETE' }, 'Kunde inte koppla från kontot.').then(
    (b) => b.account,
  );

/** Save a look as a template (the same name replaces that template). */
export const saveTemplate = (name: string, style: Omit<BrandStyle, 'savedAt'>) =>
  call<{ brand: BrandInfo }>(
    '/api/brand/templates',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, style }) },
    'Kunde inte spara mallen.',
  ).then((b) => b.brand);

export const renameTemplate = (id: string, name: string) =>
  call<{ brand: BrandInfo }>(
    `/api/brand/templates/${encodeURIComponent(id)}`,
    { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) },
    'Kunde inte byta namn på mallen.',
  ).then((b) => b.brand);

export const deleteTemplate = (id: string) =>
  call<{ brand: BrandInfo }>(`/api/brand/templates/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'Kunde inte ta bort mallen.').then(
    (b) => b.brand,
  );

export interface StyleJob {
  id: string;
  status: 'working' | 'done' | 'error';
  step: string;
  error?: string;
  template?: import('@/lib/edit/types').StyleTemplate;
}

/** Make a template from a video: a link (TikTok, YouTube ...) or a file. */
export const startStyleFromVideo = (input: { url?: string; file?: File; name?: string }) => {
  if (input.file) {
    const params = new URLSearchParams({ filename: input.file.name, ...(input.name ? { name: input.name } : {}) });
    return call<{ job: StyleJob }>(
      `/api/brand/templates/from-video?${params}`,
      { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: input.file },
      'Kunde inte ladda upp videon.',
    ).then((b) => b.job);
  }
  return call<{ job: StyleJob }>(
    '/api/brand/templates/from-video',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: input.url, name: input.name }) },
    'Kunde inte starta.',
  ).then((b) => b.job);
};

export const fetchStyleJob = (id: string) =>
  call<{ job: StyleJob }>(`/api/brand/templates/from-video/${id}`, { cache: 'no-store' }, 'Kunde inte läsa hur det går.').then((b) => b.job);
