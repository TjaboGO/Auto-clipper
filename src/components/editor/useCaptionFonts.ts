import { useEffect, useState } from 'react';
import { cssFontFamily, type CaptionFont } from '@/lib/edit/fonts';

// Each font is fetched once per page, however many components ask for it.
const loading = new Map<string, Promise<void>>();
const loaded = new Set<string>();

const fontKey = (font: CaptionFont) => `${font.id}:${font.file}`;

function loadFont(font: CaptionFont): Promise<void> {
  const key = fontKey(font);
  let promise = loading.get(key);
  if (!promise) {
    const face = new FontFace(cssFontFamily(font), `url(/api/fonts/${encodeURIComponent(font.file)})`);
    promise = face.load().then(
      (ready) => {
        document.fonts.add(ready);
        loaded.add(key);
      },
      (err) => {
        console.warn(`Kunde inte ladda typsnittet ${font.label}:`, err);
        loaded.add(key); // drawn with a fallback font rather than never
      },
    );
    loading.set(key, promise);
  }
  return promise;
}

/** Load these caption fonts into the page; true when they're ready to draw with. */
export function useCaptionFonts(fonts: CaptionFont[]): boolean {
  const [ready, setReady] = useState(false);
  const key = fonts.map(fontKey).join(',');
  useEffect(() => {
    let cancelled = false;
    // A font added to the list (one you just uploaded): not ready until it's in.
    if (fonts.some((f) => !loaded.has(fontKey(f)))) setReady(false);
    Promise.all(fonts.map(loadFont)).then(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
    // `key` names the fonts; the array itself is new on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return ready;
}
