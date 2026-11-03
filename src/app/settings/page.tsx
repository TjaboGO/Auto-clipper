'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { LogoutButton } from '@/components/LogoutButton';
import {
  clearStyle,
  deleteCookies,
  deleteFont,
  deleteLogo,
  fetchBrand,
  fetchCookies,
  deleteMusic,
  deletePexelsKey,
  deleteTemplate,
  deleteYoutubeApp,
  disconnectYoutube,
  fetchPexels,
  fetchYoutube,
  logoUrl,
  musicUrl,
  saveCookies,
  savePexelsKey,
  saveYoutubeApp,
  renameTemplate,
  uploadFont,
  uploadLogo,
  uploadMusic,
  type CookieStatus,
  type PexelsStatus,
  type YoutubeSettings,
} from '@/components/brandApi';
import { StyleSample } from '@/components/CaptionStyleParts';
import { FileButton } from '@/components/FileButton';
import { useCaptionFonts } from '@/components/editor/useCaptionFonts';
import { captionFont, cssFontFamily, setCustomFonts } from '@/lib/edit/fonts';
import { captionPreset } from '@/lib/edit/presets';
import type { BrandInfo } from '@/lib/edit/types';

const CORNERS: Record<string, string> = {
  'top-left': 'uppe till vänster',
  'top-right': 'uppe till höger',
  'bottom-left': 'nere till vänster',
  'bottom-right': 'nere till höger',
};

function Card(props: { id: string; title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <section id={props.id} className="bg-base-900 rounded-xl2 p-5 md:p-6 space-y-4 scroll-mt-6">
      <div>
        <h2 className="text-lg font-semibold">{props.title}</h2>
        {props.intro && <p className="text-sm text-gray-400 mt-1">{props.intro}</p>}
      </div>
      {props.children}
    </section>
  );
}

function SmallButton(props: { onClick: () => void; children: ReactNode; danger?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      className={`rounded-md px-3 py-1.5 text-sm disabled:opacity-50 ${
        props.danger ? 'text-red-300 hover:bg-red-500/15' : 'bg-base-800 hover:bg-base-700'
      }`}
    >
      {props.children}
    </button>
  );
}

const date = (iso?: string) =>
  iso ? new Date(iso).toLocaleString('sv-SE', { dateStyle: 'medium', timeStyle: 'short' }) : '';

export default function SettingsPage() {
  const [brand, setBrand] = useState<BrandInfo | null>(null);
  const [cookies, setCookies] = useState<CookieStatus | null>(null);
  const [pexels, setPexels] = useState<PexelsStatus | null>(null);
  const [pexelsKey, setPexelsKey] = useState('');
  const [youtube, setYoutube] = useState<YoutubeSettings | null>(null);
  const [googleApp, setGoogleApp] = useState({ clientId: '', clientSecret: '' });
  const [cookieText, setCookieText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error?: boolean; section: string } | null>(null);
  const fontsReady = useCaptionFonts(
    brand
      ? [...brand.fonts, captionFont(brand.style?.captions.font ?? 'montserrat'), ...(brand.templates ?? []).map((t) => captionFont(t.captions.font))]
      : [],
  );

  const showBrand = (next: BrandInfo) => {
    setCustomFonts(next.fonts);
    setBrand(next);
  };

  useEffect(() => {
    fetchBrand()
      .then(showBrand)
      .catch((err) => setMessage({ text: err.message, error: true, section: 'top' }));
    fetchCookies()
      .then(setCookies)
      .catch(() => undefined);
    fetchPexels()
      .then(setPexels)
      .catch(() => undefined);
    fetchYoutube()
      .then(setYoutube)
      .catch(() => undefined);
    // Back from connecting a YouTube account.
    const params = new URLSearchParams(window.location.search);
    const failed = params.get('youtube_error');
    if (failed || params.get('youtube') === 'connected') {
      setMessage(failed ? { text: failed, error: true, section: 'publicera' } : { text: 'YouTube-kontot är kopplat.', section: 'publicera' });
      window.history.replaceState(null, '', `${window.location.pathname}#publicera`);
    }
  }, []);

  async function run(section: string, job: () => Promise<string | null>) {
    setBusy(section);
    setMessage(null);
    try {
      const text = await job();
      if (text) setMessage({ text, section });
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : String(err), error: true, section });
    } finally {
      setBusy(null);
    }
  }

  const note = (section: string) =>
    message?.section === section && (
      <p
        role="status"
        className={`rounded-md px-3 py-2 text-sm ${message.error ? 'bg-red-500/15 text-red-200' : 'bg-accent-500/15 text-accent-300'}`}
      >
        {message.text}
      </p>
    );

  const style = brand?.style;

  return (
    <main className="max-w-3xl mx-auto px-4 py-12 md:py-16 space-y-6">
      <div>
        <div className="flex items-center justify-between">
          <Link href="/" className="text-sm text-gray-400 hover:text-white">
            &larr; Ny video
          </Link>
          <LogoutButton />
        </div>
        <h1 className="text-2xl font-bold mt-4">Inställningar</h1>
        <p className="text-sm text-gray-400 mt-1">Ditt varumärke för klippen, B-roll, och YouTube.</p>
      </div>
      {note('top')}

      {!brand ? (
        <p className="text-gray-400 text-sm">Laddar ...</p>
      ) : (
        <>
          <Card
            id="stil"
            title="Min stil"
            intro="Hur dina klipp ser ut: textstil, typsnitt, färger, rubrik och logga. Välj Min stil när du skapar klipp."
          >
            {style ? (
              <div className="flex flex-wrap items-center gap-4">
                <div className="rounded-lg bg-base-800 px-4 py-3 min-w-40">
                  <StyleSample style={style.captions} fontsReady={fontsReady} />
                </div>
                <div className="text-sm text-gray-300 space-y-0.5 mr-auto">
                  <p>
                    {captionPreset(style.captions.preset).label}, {captionFont(style.captions.font).label}
                    {style.captions.uppercase ? ', versaler' : ''}
                  </p>
                  <p className="text-gray-400">
                    Rubrik {style.title.enabled ? (style.title.duration === 'all' ? 'hela klippet' : 'i början') : 'av'}
                    {' · '}
                    Logga {style.logo.enabled ? `${CORNERS[style.logo.corner]}` : 'av'}
                  </p>
                  <p className="text-xs text-gray-500">Sparad {date(style.savedAt)}</p>
                </div>
                <SmallButton danger disabled={busy === 'stil'} onClick={() => run('stil', async () => {
                  showBrand(await clearStyle());
                  return 'Min stil är borttagen.';
                })}>
                  Ta bort
                </SmallButton>
              </div>
            ) : (
              <p className="text-sm text-gray-300">
                Ingen sparad stil än. Öppna ett klipp i redigeraren, gör det som du vill ha det och tryck på{' '}
                <span className="font-medium">Spara ...</span> vid Stil.
              </p>
            )}
            {note('stil')}
          </Card>

          <Card
            id="mallar"
            title="Mallar"
            intro="Fler sparade stilar, med egna namn, till exempel en per kanal eller serie. Spara en i redigeraren med Spara ... och ett namn."
          >
            {(brand.templates ?? []).length === 0 ? (
              <p className="text-sm text-gray-400">Inga mallar än.</p>
            ) : (
              <ul className="space-y-2">
                {(brand.templates ?? []).map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center gap-3 rounded-lg bg-base-800/60 px-3 py-2">
                    <div className="rounded-md bg-base-800 px-3 py-2 min-w-32">
                      <StyleSample style={t.captions} fontsReady={fontsReady} />
                    </div>
                    <div className="text-sm mr-auto min-w-0">
                      <p className="font-medium truncate">{t.name}</p>
                      <p className="text-xs text-gray-400">
                        {captionPreset(t.captions.preset).label}, {captionFont(t.captions.font).label}
                        {t.progress?.enabled ? ' · förloppsstapel' : ''}
                        {t.zoom && t.zoom !== 'off' ? ' · zoom' : ''}
                        {t.logo.enabled ? ' · logga' : ''}
                      </p>
                    </div>
                    <SmallButton disabled={busy === 'mallar'} onClick={() => {
                      const name = window.prompt('Nytt namn på mallen', t.name);
                      if (name && name.trim() && name.trim() !== t.name) {
                        run('mallar', async () => {
                          showBrand(await renameTemplate(t.id, name));
                          return null;
                        });
                      }
                    }}>
                      Byt namn
                    </SmallButton>
                    <SmallButton danger disabled={busy === 'mallar'} onClick={() => run('mallar', async () => {
                      showBrand(await deleteTemplate(t.id));
                      return `${t.name} är borttagen.`;
                    })}>
                      Ta bort
                    </SmallButton>
                  </li>
                ))}
              </ul>
            )}
            {note('mallar')}
          </Card>

          <Card
            id="typsnitt"
            title="Egna typsnitt"
            intro="Ladda upp .ttf- eller .otf-filer. De dyker upp i redigeraren under Typsnitt."
          >
            {brand.fonts.length > 0 && (
              <ul className="divide-y divide-base-800 rounded-lg bg-base-800/40">
                {brand.fonts.map((f) => (
                  <li key={f.id} className="flex items-center gap-3 px-3 py-2.5">
                    <div className="min-w-0 mr-auto">
                      <p className="text-xl truncate" style={{ fontFamily: fontsReady ? `"${cssFontFamily(f)}"` : undefined }}>
                        Så här ser det ut, åäö
                      </p>
                      <p className="text-xs text-gray-400 truncate">
                        {f.label} · {f.original}
                        {!f.nordic && <span className="text-amber-300"> · saknar å, ä eller ö</span>}
                      </p>
                    </div>
                    <SmallButton danger disabled={busy === 'typsnitt'} onClick={() => run('typsnitt', async () => {
                      showBrand(await deleteFont(f.id));
                      return `${f.label} är borttaget. Klipp som använde det får Montserrat.`;
                    })}>
                      Ta bort
                    </SmallButton>
                  </li>
                ))}
              </ul>
            )}
            <FileButton accept=".ttf,.otf,font/ttf,font/otf" busy={busy === 'typsnitt'} onFile={(file) => run('typsnitt', async () => {
              const { font, brand: next } = await uploadFont(file);
              showBrand(next);
              return font.nordic
                ? `${font.label} är tillagt.`
                : `${font.label} är tillagt, men saknar å, ä eller ö. De bokstäverna visas med ett annat typsnitt.`;
            })}>
              + Ladda upp typsnitt
            </FileButton>
            <p className="text-xs text-gray-500">
              Använd bara typsnitt du har rätt att använda i video. Fria typsnitt finns till exempel på Google Fonts.
            </p>
            {note('typsnitt')}
          </Card>

          <Card
            id="logga"
            title="Logga"
            intro="Läggs i ett hörn av klippen. Slå på den per klipp i redigeraren under Logga, eller spara den i Min stil."
          >
            <div className="flex flex-wrap items-center gap-4">
              {brand.logo ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={logoUrl(brand.logo.version)}
                    alt="Din logga"
                    className="h-20 w-32 object-contain rounded-lg bg-[repeating-conic-gradient(#2a2a35_0%_25%,#1f1f28_0%_50%)] bg-[length:14px_14px]"
                  />
                  <FileButton accept="image/png,image/jpeg,image/webp" busy={busy === 'logga'} onFile={(file) => run('logga', async () => {
                    showBrand(await uploadLogo(file));
                    return 'Loggan är bytt.';
                  })}>
                    Byt logga
                  </FileButton>
                  <SmallButton danger disabled={busy === 'logga'} onClick={() => run('logga', async () => {
                    showBrand(await deleteLogo());
                    return 'Loggan är borttagen.';
                  })}>
                    Ta bort
                  </SmallButton>
                </>
              ) : (
                <FileButton accept="image/png,image/jpeg,image/webp" busy={busy === 'logga'} onFile={(file) => run('logga', async () => {
                  showBrand(await uploadLogo(file));
                  return 'Loggan är uppladdad.';
                })}>
                  Ladda upp logga
                </FileButton>
              )}
            </div>
            <p className="text-xs text-gray-500">PNG, JPEG eller WebP. En PNG med genomskinlig bakgrund blir snyggast.</p>
            {note('logga')}
          </Card>

          <Card
            id="musik"
            title="Musik"
            intro="Låtar att lägga under klippen. Välj låt per klipp i redigeraren under Ljud, eller när du skapar klipp. Musiken sänks automatiskt när någon pratar."
          >
            {(brand.music ?? []).length > 0 && (
              <ul className="divide-y divide-base-800 rounded-lg bg-base-800/40">
                {(brand.music ?? []).map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                    <div className="min-w-0 mr-auto">
                      <p className="truncate">{t.name}</p>
                      <p className="text-xs text-gray-400">
                        {Math.floor(t.duration / 60)}:{String(Math.round(t.duration % 60)).padStart(2, '0')}
                      </p>
                    </div>
                    <audio controls preload="none" src={musicUrl(t.id)} className="h-8 max-w-[220px]" />
                    <SmallButton danger disabled={busy === 'musik'} onClick={() => run('musik', async () => {
                      showBrand(await deleteMusic(t.id));
                      return `${t.name} är borttagen. Klipp som hade den blir utan musik nästa gång de renderas.`;
                    })}>
                      Ta bort
                    </SmallButton>
                  </li>
                ))}
              </ul>
            )}
            <FileButton accept="audio/*,.mp3,.m4a,.wav,.ogg,.aac,.flac" busy={busy === 'musik'} onFile={(file) => run('musik', async () => {
              const { track, brand: next } = await uploadMusic(file);
              showBrand(next);
              return `${track.name} är uppladdad.`;
            })}>
              + Ladda upp musik
            </FileButton>
            <p className="text-xs text-gray-500">
              MP3, M4A, WAV eller OGG, högst 40 MB. Använd bara musik du har rätt att använda, till exempel från
              YouTubes ljudbibliotek eller annan royaltyfri musik.
            </p>
            {note('musik')}
          </Card>
        </>
      )}

      <Card
        id="broll"
        title="B-roll från Pexels"
        intro="Gratis videoklipp att lägga över dina klipp, sökta och valda av AI:n eller av dig i redigeraren. Skapa en gratis nyckel på pexels.com/api och klistra in den här."
      >
        {pexels?.fromEnv ? (
          <p className="text-sm text-gray-300">Nyckeln kommer från PEXELS_API_KEY i serverns inställningar.</p>
        ) : pexels?.configured ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-accent-300 mr-auto">En nyckel är sparad.</p>
            <SmallButton danger disabled={busy === 'broll'} onClick={() => run('broll', async () => {
              setPexels(await deletePexelsKey());
              return 'Nyckeln är borttagen.';
            })}>
              Ta bort
            </SmallButton>
          </div>
        ) : (
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              run('broll', async () => {
                setPexels(await savePexelsKey(pexelsKey));
                setPexelsKey('');
                return 'Nyckeln är sparad. Nu finns B-roll i redigeraren.';
              });
            }}
          >
            <input
              type="password"
              value={pexelsKey}
              onChange={(e) => setPexelsKey(e.target.value)}
              placeholder="Pexels API-nyckel"
              aria-label="Pexels API-nyckel"
              autoComplete="off"
              className="min-w-0 flex-1 rounded-lg bg-base-800 px-3 py-2 text-sm"
            />
            <button type="submit" disabled={busy === 'broll' || !pexelsKey.trim()} className="rounded-lg bg-accent-500 hover:bg-accent-400 disabled:opacity-50 px-4 py-2 text-sm font-semibold">
              Spara
            </button>
          </form>
        )}
        <p className="text-xs text-gray-500">
          Pexels-videor är gratis att använda. Den som filmat krediteras i redigeraren och i klipp.txt.
        </p>
        {note('broll')}
      </Card>

      <Card
        id="publicera"
        title="Publicera på YouTube"
        intro="Ladda upp klipp direkt till din kanal, eller schemalägg dem. Det kräver en egen Google-app (gratis), som du gör en gång."
      >
        {youtube?.app.configured ? (
          <>
            {youtube.account.connected ? (
              <div className="flex flex-wrap items-center gap-3">
                <p className="text-sm text-accent-300 mr-auto">
                  Kopplad till {youtube.account.channel?.title ?? 'din kanal'}
                  {youtube.account.connectedAt ? <span className="text-gray-500"> · {date(youtube.account.connectedAt)}</span> : null}
                </p>
                <SmallButton danger disabled={busy === 'publicera'} onClick={() => run('publicera', async () => {
                  const account = await disconnectYoutube();
                  setYoutube((y) => (y ? { ...y, account } : y));
                  return 'Kontot är frånkopplat.';
                })}>
                  Koppla från
                </SmallButton>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <p className="text-sm text-gray-400 mr-auto">Inget konto kopplat än.</p>
                <a href="/api/youtube/connect" className="rounded-lg bg-accent-500 hover:bg-accent-400 px-4 py-2 text-sm font-semibold">
                  Koppla YouTube-konto
                </a>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-3 text-xs text-gray-500">
              <span className="mr-auto break-all">Google-app: {youtube.app.clientId}</span>
              {!youtube.app.fromEnv && (
                <SmallButton danger disabled={busy === 'publicera'} onClick={() => run('publicera', async () => {
                  const app = await deleteYoutubeApp();
                  setYoutube((y) => (y ? { ...y, app, account: { connected: false } } : y));
                  return 'Google-appen är borttagen.';
                })}>
                  Byt app
                </SmallButton>
              )}
            </div>
          </>
        ) : (
          <>
            <ol className="text-sm text-gray-300 list-decimal pl-5 space-y-1">
              <li>Gå till console.cloud.google.com och skapa ett projekt.</li>
              <li>Slå på &quot;YouTube Data API v3&quot; under APIs &amp; Services.</li>
              <li>Ställ in OAuth consent screen: External, och lägg till din egen e-post som testanvändare.</li>
              <li>
                Skapa Credentials, OAuth client ID, typ Web application, och lägg till den här adressen under
                Authorized redirect URIs:
              </li>
            </ol>
            {youtube && (
              <p className="font-mono text-xs bg-base-800 rounded-md px-3 py-2 break-all select-all">{youtube.redirectUri}</p>
            )}
            <p className="text-sm text-gray-300">5. Klistra in klient-id och klienthemlighet här.</p>
            <form
              className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]"
              onSubmit={(e) => {
                e.preventDefault();
                run('publicera', async () => {
                  const app = await saveYoutubeApp(googleApp.clientId, googleApp.clientSecret);
                  setYoutube((y) => (y ? { ...y, app, account: { connected: false } } : y));
                  setGoogleApp({ clientId: '', clientSecret: '' });
                  return 'Google-appen är sparad. Koppla nu ditt YouTube-konto.';
                });
              }}
            >
              <input
                value={googleApp.clientId}
                onChange={(e) => setGoogleApp((g) => ({ ...g, clientId: e.target.value }))}
                placeholder="Klient-id"
                aria-label="Klient-id"
                autoComplete="off"
                className="min-w-0 rounded-lg bg-base-800 px-3 py-2 text-sm"
              />
              <input
                type="password"
                value={googleApp.clientSecret}
                onChange={(e) => setGoogleApp((g) => ({ ...g, clientSecret: e.target.value }))}
                placeholder="Klienthemlighet"
                aria-label="Klienthemlighet"
                autoComplete="off"
                className="min-w-0 rounded-lg bg-base-800 px-3 py-2 text-sm"
              />
              <button
                type="submit"
                disabled={busy === 'publicera' || !googleApp.clientId.trim() || !googleApp.clientSecret.trim()}
                className="rounded-lg bg-accent-500 hover:bg-accent-400 disabled:opacity-50 px-4 py-2 text-sm font-semibold"
              >
                Spara
              </button>
            </form>
          </>
        )}
        <p className="text-xs text-gray-500">
          En ny Google-app får ladda upp ungefär sex videor per dag. Tills Google har granskat appen blir uppladdade
          videor låsta som privata, så då kan du publicera dem själv i YouTube Studio.
        </p>
        {note('publicera')}
      </Card>

      <Card
        id="youtube"
        title="Hämta från YouTube"
        intro="YouTube stoppar ofta nedladdningar från servrar, och alltid för videor med åldersgräns. Med cookies från ett inloggat konto går det oftast ändå."
      >
        {cookies && (
          <p className="text-sm">
            {cookies.present ? (
              <>
                <span className={cookies.expired ? 'text-amber-300' : 'text-accent-300'}>
                  {cookies.expired ? 'Cookies finns men har gått ut.' : 'Cookies är sparade.'}
                </span>{' '}
                <span className="text-gray-400">
                  {cookies.youtube} för YouTube/Google
                  {cookies.signedIn ? ', inloggad' : ', verkar inte vara inloggad'}
                  {cookies.updatedAt ? ` · ${date(cookies.updatedAt)}` : ''}
                </span>
              </>
            ) : (
              <span className="text-gray-400">Inga cookies sparade.</span>
            )}
          </p>
        )}
        {cookies?.fromEnv ? (
          <p className="text-sm text-gray-400">Cookies kommer från miljövariabeln YTDLP_COOKIES och ändras där.</p>
        ) : (
          <>
            <ol className="text-sm text-gray-300 list-decimal pl-5 space-y-1">
              <li>Logga in på YouTube i din webbläsare (gärna med ett konto bara för det här).</li>
              <li>
                Exportera cookies för youtube.com som en <span className="font-mono text-xs">cookies.txt</span>, till
                exempel med tillägget &quot;Get cookies.txt LOCALLY&quot;.
              </li>
              <li>Klistra in innehållet här, eller välj filen.</li>
            </ol>
            <textarea
              value={cookieText}
              onChange={(e) => setCookieText(e.target.value)}
              rows={4}
              spellCheck={false}
              placeholder="# Netscape HTTP Cookie File"
              aria-label="Innehållet i cookies.txt"
              className="w-full rounded-lg bg-base-800 border border-base-700 px-3 py-2 text-xs font-mono focus:outline-none focus:border-accent-500"
            />
            <div className="flex flex-wrap gap-2">
              <SmallButton disabled={!cookieText.trim() || busy === 'youtube'} onClick={() => run('youtube', async () => {
                setCookies(await saveCookies(cookieText));
                setCookieText('');
                return 'Cookies är sparade. De används nästa gång en video laddas ner.';
              })}>
                Spara
              </SmallButton>
              <FileButton accept=".txt,text/plain" busy={busy === 'youtube'} onFile={(file) => run('youtube', async () => {
                setCookies(await saveCookies(await file.text()));
                return 'Cookies är sparade. De används nästa gång en video laddas ner.';
              })}>
                Välj fil
              </FileButton>
              {cookies?.present && (
                <SmallButton danger disabled={busy === 'youtube'} onClick={() => run('youtube', async () => {
                  setCookies(await deleteCookies());
                  return 'Cookies är borttagna.';
                })}>
                  Ta bort
                </SmallButton>
              )}
            </div>
            <p className="text-xs text-gray-500">
              Cookies ger tillgång till kontot. De visas aldrig igen här, men alla som kan öppna appen kan ladda ner
              videor med dem. Därför bör appen ligga bakom lösenord.
            </p>
          </>
        )}
        {note('youtube')}
      </Card>
    </main>
  );
}
