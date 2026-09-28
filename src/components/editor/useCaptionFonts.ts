import { useEffect, useState } from 'react';
import { CAPTION_FONTS, cssFontFamily } from '@/lib/edit/fonts';

let loading: Promise<void> | null = null;

/** Load every caption font into the page once; true when they're ready to draw with. */
export function useCaptionFonts(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    loading ??= Promise.all(
      CAPTION_FONTS.map(async (font) => {
        const face = new FontFace(cssFontFamily(font), `url(/api/fonts/${font.file})`);
        await face.load();
        document.fonts.add(face);
      }),
    ).then(
      () => undefined,
      (err) => console.warn('Kunde inte ladda typsnitten:', err),
    );
    loading.then(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return ready;
}
