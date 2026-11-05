// Translated captions. Each transcript sentence is translated as a whole
// (word-for-word doesn't work between languages), and its words are spread
// over the time the spoken sentence takes in the clip, longer words getting
// more time. The highlight then moves through the translation at the pace
// of the speech.
import type { OutputWord } from './timeline';
import type { CaptionTranslation, ClipEdit, EditorWord } from './types';

/** Languages the captions can be translated into (Latin script, so the caption fonts have the letters). */
export const CAPTION_LANGUAGES: { code: string; label: string; english: string }[] = [
  { code: 'en', label: 'Engelska', english: 'English' },
  { code: 'sv', label: 'Svenska', english: 'Swedish' },
  { code: 'no', label: 'Norska', english: 'Norwegian (Bokmål)' },
  { code: 'da', label: 'Danska', english: 'Danish' },
  { code: 'fi', label: 'Finska', english: 'Finnish' },
  { code: 'de', label: 'Tyska', english: 'German' },
  { code: 'fr', label: 'Franska', english: 'French' },
  { code: 'es', label: 'Spanska', english: 'Spanish' },
  { code: 'it', label: 'Italienska', english: 'Italian' },
  { code: 'pt', label: 'Portugisiska', english: 'Portuguese' },
  { code: 'nl', label: 'Nederländska', english: 'Dutch' },
  { code: 'pl', label: 'Polska', english: 'Polish' },
];

export function captionLanguage(code: string | null | undefined) {
  return CAPTION_LANGUAGES.find((l) => l.code === code) ?? null;
}

/**
 * The caption words in the translation: every run of words from one
 * sentence is replaced by that sentence's translation, spread over the
 * same time. Sentences without a translation stay as they are.
 */
export function translatedWords(words: OutputWord[], translation: CaptionTranslation | null): OutputWord[] {
  if (!translation) return words;
  const out: OutputWord[] = [];
  let i = 0;
  while (i < words.length) {
    let j = i;
    while (j + 1 < words.length && words[j + 1].seg === words[i].seg) j++;
    const run = words.slice(i, j + 1);
    const text = translation.segments[String(words[i].seg)]?.trim();
    const parts = text ? text.split(/\s+/).filter(Boolean) : [];
    if (parts.length === 0) {
      out.push(...run);
    } else {
      const start = run[0].start;
      const end = run[run.length - 1].end;
      const weights = parts.map((p) => p.length + 1);
      const total = weights.reduce((a, b) => a + b, 0);
      let at = start;
      parts.forEach((part, k) => {
        const length = ((end - start) * weights[k]) / total;
        out.push({ id: `${words[i].seg}:t${k}`, text: part, start: at, end: at + length, seg: words[i].seg, emphasis: false });
        at += length;
      });
    }
    i = j + 1;
  }
  return out;
}

/**
 * The sentences a clip needs translated: every transcript sentence with a
 * word between `start` and `end`, as the user spells it (hidden words left
 * out). Keyed by the sentence's index.
 */
export function sentencesToTranslate(words: EditorWord[], edit: Pick<ClipEdit, 'start' | 'end' | 'words'>): { id: number; text: string }[] {
  const bySeg = new Map<number, string[]>();
  const inClip = new Set(words.filter((w) => w.end > edit.start && w.start < edit.end).map((w) => w.seg));
  for (const w of words) {
    if (!inClip.has(w.seg)) continue;
    const override = edit.words[w.id];
    if (override?.hidden) continue;
    const text = (override?.text ?? w.text).trim();
    if (!text) continue;
    bySeg.set(w.seg, [...(bySeg.get(w.seg) ?? []), text]);
  }
  return [...bySeg].map(([id, parts]) => ({ id, text: parts.join(' ') }));
}
