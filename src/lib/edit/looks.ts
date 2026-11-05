// Färdiga stilar: whole looks that come with the app. Each is a text style,
// a pace (pauses and filler sounds), zoom, what happens at the cuts, a
// progress bar and a title, picked as one, the same way as your own
// templates. Plain data, shared by the upload form, the editor and the
// pipeline.
import { DEFAULT_LOGO, presetCaptions } from './presets';
import type { BrandStyle, CaptionPresetId, CaptionSettings } from './types';

export interface BuiltInLook {
  /** "s-" + a short name. */
  id: `s-${string}`;
  name: string;
  /** What kind of video it suits, in a few words. */
  description: string;
  style: Omit<BrandStyle, 'savedAt'>;
}

const captions = (preset: CaptionPresetId, changes: Partial<CaptionSettings>): CaptionSettings => ({
  ...presetCaptions(preset),
  ...changes,
});

const noBar = { enabled: false, color: '#FFFFFF', position: 'bottom' as const };

export const BUILT_IN_LOOKS: BuiltInLook[] = [
  {
    id: 's-podd',
    name: 'Podd',
    description: 'Samtal och intervjuer: tight tempo, zoom vid varje klipp',
    style: {
      captions: captions('karaoke', { font: 'montserrat', uppercase: true, maxWords: 3, emojis: false }),
      title: { enabled: true, duration: 'intro' },
      logo: DEFAULT_LOGO,
      zoom: 'light',
      zoomStyle: 'smooth',
      transition: 'punch',
      progress: noBar,
      removeFillers: true,
      removePauses: true,
    },
  },
  {
    id: 's-energi',
    name: 'Energisk',
    description: 'Högt tempo, studsande text, blixt vid klippen',
    style: {
      captions: captions('bounce', { maxWords: 2, emojis: true }),
      title: { enabled: true, duration: 'intro' },
      logo: DEFAULT_LOGO,
      zoom: 'strong',
      zoomStyle: 'cut',
      transition: 'flash',
      progress: { enabled: true, color: '#FFD23F', position: 'bottom' },
      removeFillers: true,
      removePauses: true,
    },
  },
  {
    id: 's-utbildning',
    name: 'Utbildning',
    description: 'Förklarande och tydligt, rubrik hela klippet',
    style: {
      captions: captions('box', { font: 'poppins', maxWords: 4, emojis: false }),
      title: { enabled: true, duration: 'all' },
      logo: DEFAULT_LOGO,
      zoom: 'light',
      zoomStyle: 'smooth',
      transition: 'none',
      progress: { enabled: true, color: '#7C5CFF', position: 'top' },
      removeFillers: true,
      removePauses: false,
    },
  },
  {
    id: 's-gaming',
    name: 'Gaming',
    description: 'Neontext, hopp-zoom och blixt',
    style: {
      captions: captions('neon', { maxWords: 3, emojis: true }),
      title: { enabled: true, duration: 'intro' },
      logo: DEFAULT_LOGO,
      zoom: 'medium',
      zoomStyle: 'cut',
      transition: 'flash',
      progress: noBar,
      removeFillers: false,
      removePauses: true,
    },
  },
  {
    id: 's-berattelse',
    name: 'Berättelse',
    description: 'Orden kommer fram när de sägs, pauserna får vara kvar',
    style: {
      captions: captions('reveal', { maxWords: 4, emojis: false }),
      title: { enabled: true, duration: 'intro' },
      logo: DEFAULT_LOGO,
      zoom: 'medium',
      zoomStyle: 'smooth',
      transition: 'none',
      progress: noBar,
      removeFillers: true,
      removePauses: false,
    },
  },
  {
    id: 's-motivation',
    name: 'Motivation',
    description: 'Ett stort ord i taget, zoom vid klippen',
    style: {
      captions: captions('word', { font: 'anton', size: 1.1, emojis: false }),
      title: { enabled: true, duration: 'intro' },
      logo: DEFAULT_LOGO,
      zoom: 'medium',
      zoomStyle: 'smooth',
      transition: 'punch',
      progress: { enabled: true, color: '#FFFFFF', position: 'bottom' },
      removeFillers: true,
      removePauses: true,
    },
  },
  {
    id: 's-vlogg',
    name: 'Vlogg',
    description: 'Avslappnat, runda bokstäver och emojis',
    style: {
      captions: captions('pop', { font: 'fredoka', uppercase: false, maxWords: 3, emojis: true }),
      title: { enabled: false, duration: 'intro' },
      logo: DEFAULT_LOGO,
      zoom: 'light',
      zoomStyle: 'smooth',
      transition: 'none',
      progress: noBar,
      removeFillers: true,
      removePauses: false,
    },
  },
  {
    id: 's-nyheter',
    name: 'Nyheter',
    description: 'Saklig ruta-text, rubrik och stapel överst',
    style: {
      captions: captions('box', { font: 'archivo', uppercase: true, maxWords: 4, highlightColor: '#FF4D4D', emojis: false }),
      title: { enabled: true, duration: 'all' },
      logo: DEFAULT_LOGO,
      zoom: 'off',
      zoomStyle: 'smooth',
      transition: 'none',
      progress: { enabled: true, color: '#FF4D4D', position: 'top' },
      removeFillers: true,
      removePauses: false,
    },
  },
  {
    id: 's-minimal',
    name: 'Minimal',
    description: 'Lugn, enkel text utan effekter',
    style: {
      captions: captions('clean', { emojis: false }),
      title: { enabled: false, duration: 'intro' },
      logo: DEFAULT_LOGO,
      zoom: 'off',
      zoomStyle: 'smooth',
      transition: 'none',
      progress: noBar,
      removeFillers: false,
      removePauses: false,
    },
  },
];

export function builtInLook(id: string): BuiltInLook | null {
  return BUILT_IN_LOOKS.find((l) => l.id === id) ?? null;
}

/** Is this one of the app's own looks? */
export function isLookChoice(choice: string): choice is `s-${string}` {
  return builtInLook(choice) !== null;
}
