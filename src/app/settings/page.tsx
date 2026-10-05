'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  clearStyle,
  deleteCookies,
  deleteFont,
  deleteLogo,
  fetchBrand,
  fetchCookies,
  logoUrl,
  saveCookies,
  uploadFont,
  uploadLogo,
  type CookieStatus,
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
  const [cookieText, setCookieText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error?: boolean; section: string } | null>(null);
  const fontsReady = useCaptionFonts(brand ? [...brand.fonts, captionFont(brand.style?.captions.font ?? 'montserrat')] : []);

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
        <Link href="/" className="text-sm text-gray-400 hover:text-white">
          &larr; Ny video
        </Link>
        <h1 className="text-2xl font-bold mt-4">Inställningar</h1>
        <p className="text-sm text-gray-400 mt-1">Ditt varumärke för klippen, och cookies för YouTube.</p>
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
                <span className="font-medium">Spara</span> vid Min stil.
              </p>
            )}
            {note('stil')}
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
        </>
      )}

      <Card
        id="youtube"
        title="YouTube"
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
