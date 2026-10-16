'use client';

import { useRef, useState, type ReactNode } from 'react';
import { logoUrl, saveStyle, uploadFont, uploadLogo } from '@/components/brandApi';
import { AspectIcon, CaptionPresetPicker } from '@/components/CaptionStyleParts';
import { FileButton } from '@/components/FileButton';
import { CAPTION_FONTS, cssFontFamily, type CaptionFont } from '@/lib/edit/fonts';
import {
  ASPECT_LABELS,
  defaultCamShare,
  defaultScreenShare,
  OUTPUT_SIZES,
  PANEL_SIZE_RANGE,
  splitAllowed,
  type ResolvedLayout,
} from '@/lib/edit/layout';
import { captionPreset, LOGO_CORNERS, presetCaptions, withStyle } from '@/lib/edit/presets';
import { CAPTION_LANGUAGES, captionLanguage } from '@/lib/edit/translation';
import type {
  AspectRatio,
  BrandInfo,
  CaptionSettings,
  ClipEdit,
  FramingAnalysis,
  LayoutMode,
  LogoCorner,
  LogoSettings,
  SourceInfo,
} from '@/lib/edit/types';
import { formatTime } from './format';

type Tab = 'text' | 'layout' | 'title' | 'logo';

const CORNER_LABELS: Record<LogoCorner, string> = {
  'top-left': 'Uppe till vänster',
  'top-right': 'Uppe till höger',
  'bottom-left': 'Nere till vänster',
  'bottom-right': 'Nere till höger',
};

interface SettingsPanelProps {
  edit: ClipEdit;
  set: (edit: ClipEdit, key?: string) => void;
  analysis: FramingAnalysis | null;
  resolved: { layout: ResolvedLayout; note?: string };
  /** Where the captions go unless moved (share of the height). */
  captionAuto: number;
  source: SourceInfo;
  /** Whether manual framing makes sense (the crop moves sideways). */
  canCrop: boolean;
  cropMode: boolean;
  onCropMode: (on: boolean) => void;
  /** Playhead, source time. */
  time: number;
  fontsReady: boolean;
  /** Your fonts, logo and "Min stil". */
  brand: BrandInfo;
  onBrand: (brand: BrandInfo) => void;
  /** The clip's sentences (for editing their translations). */
  sentences: { id: number; text: string }[];
  /** Translate the captions into a language (puts the translation in the edit). */
  onTranslate: (lang: string) => Promise<void>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400">{title}</h3>
      {children}
    </section>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-3 text-sm cursor-pointer">
      <span>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? 'bg-accent-500' : 'bg-base-700'}`}
      >
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${checked ? 'left-[22px]' : 'left-0.5'}`} />
      </button>
    </label>
  );
}

/** A slider whose drag counts as one undo step. */
function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number, key: string) => void;
}) {
  const key = useRef(`${props.label}-0`);
  const begin = () => {
    key.current = `${props.label}-${Date.now()}`;
  };
  return (
    <label className="block text-sm">
      <span className="flex justify-between mb-1">
        <span>{props.label}</span>
        <span className="text-gray-400 tabular-nums">{props.format(props.value)}</span>
      </span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onPointerDown={begin}
        onKeyDown={begin}
        onChange={(e) => props.onChange(Number(e.target.value), key.current)}
        className="w-full accent-accent-500"
      />
    </label>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string, key: string) => void }) {
  const key = useRef(`${label}-0`);
  const swatches = ['#FFFFFF', '#FFD700', '#FFE14D', '#4ADE80', '#22D3EE', '#7C5CFF', '#F472B6', '#FF4D4D'];
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-sm">
        <span>{label}</span>
        <input
          type="color"
          value={value.toLowerCase()}
          onFocus={() => (key.current = `${label}-${Date.now()}`)}
          onChange={(e) => onChange(e.target.value.toUpperCase(), key.current)}
          className="h-7 w-10 cursor-pointer rounded border border-base-700 bg-transparent"
          aria-label={label}
        />
      </div>
      <div className="flex gap-1.5">
        {swatches.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => onChange(c, `${label}-${Date.now()}`)}
            className={`h-5 w-5 rounded-full border ${value === c ? 'border-white ring-2 ring-accent-500' : 'border-base-700'}`}
            style={{ background: c }}
            aria-label={`${label}: ${c}`}
          />
        ))}
      </div>
    </div>
  );
}

function FontButton(props: { font: CaptionFont; active: boolean; fontsReady: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      title={props.font.label}
      className={`rounded-md border px-2 py-1.5 text-left text-sm truncate ${props.active ? 'border-accent-500 bg-accent-500/10' : 'border-base-700 hover:border-base-600'}`}
      style={{ fontFamily: props.fontsReady ? `"${cssFontFamily(props.font)}"` : undefined }}
    >
      {props.font.label}
    </button>
  );
}

export function SettingsPanel(props: SettingsPanelProps) {
  const { edit, set } = props;
  const [tab, setTab] = useState<Tab>('text');
  const captions = edit.captions;
  const preset = captionPreset(captions.preset);
  const setCaptions = (patch: Partial<CaptionSettings>, key?: string) =>
    set({ ...edit, captions: { ...captions, ...patch } }, key);
  const splitPossible = !!props.analysis?.split && splitAllowed(edit.aspect);
  const facecam = props.analysis?.facecam ?? null;
  const camPossible = !!facecam && splitAllowed(edit.aspect);
  const groupSize = props.analysis?.group?.length ?? 0;
  const { brand, onBrand } = props;
  const [busy, setBusy] = useState<'font' | 'logo' | 'style' | 'translate' | null>(null);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const setLogo = (patch: Partial<LogoSettings>, key?: string) => set({ ...edit, logo: { ...edit.logo, ...patch } }, key);

  async function run(what: 'font' | 'logo' | 'style' | 'translate', job: () => Promise<string | null>) {
    setBusy(what);
    setMessage(null);
    try {
      const text = await job();
      if (text) setMessage({ text });
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : String(err), error: true });
    } finally {
      setBusy(null);
    }
  }

  const addFont = (file: File) =>
    run('font', async () => {
      const { font, brand: next } = await uploadFont(file);
      onBrand(next);
      setCaptions({ font: font.id });
      return font.nordic
        ? `${font.label} är tillagt.`
        : `${font.label} är tillagt, men saknar å, ä eller ö. De bokstäverna visas med ett annat typsnitt.`;
    });

  const addLogo = (file: File) =>
    run('logo', async () => {
      onBrand(await uploadLogo(file));
      setLogo({ enabled: true });
      return 'Loggan är uppladdad. Den gäller alla klipp där du slår på den.';
    });

  const saveAsMine = () =>
    run('style', async () => {
      onBrand(
        await saveStyle({
          captions: edit.captions,
          title: { enabled: edit.title.enabled, duration: edit.title.duration },
          logo: edit.logo,
        }),
      );
      return 'Sparad som Min stil. Välj Min stil när du skapar klipp, så får de den här looken.';
    });

  const translation = edit.translation;
  const translateTo = (lang: string) => {
    if (!lang) {
      set({ ...edit, translation: null });
      setMessage({ text: 'Texten visas på originalspråket igen.' });
      return;
    }
    run('translate', async () => {
      await props.onTranslate(lang);
      return `Översatt till ${(captionLanguage(lang)?.label ?? lang).toLowerCase()}. Rätta meningarna här under om något blev fel.`;
    });
  };
  const setSentence = (id: number, text: string) => {
    if (!translation) return;
    set({ ...edit, translation: { ...translation, segments: { ...translation.segments, [String(id)]: text } } }, `translation-${id}`);
  };

  const applyMine = () => {
    if (!brand.style) return;
    set(withStyle(edit, brand.style, !!brand.logo));
    setMessage({ text: 'Min stil är använd på klippet.' });
  };

  const layouts: { id: LayoutMode; label: string; hint: string; disabled?: boolean }[] = [
    { id: 'auto', label: 'Auto', hint: 'Väljer själv utifrån vad som syns i bilden' },
    { id: 'fill', label: 'Följ talaren', hint: 'Beskär runt den som pratar' },
    { id: 'fit', label: 'Hela bilden', hint: 'Hela videon, suddig bakgrund runt om' },
    {
      id: 'split',
      label: 'Split screen',
      hint: splitPossible ? 'Två personer, en upptill och en nedtill' : 'Kräver två personer i bild (och inte 16:9)',
      disabled: !splitPossible,
    },
    {
      id: 'facecam',
      label: 'Spel med facecam',
      hint: camPossible ? 'Kameran upptill, spelet nedtill' : 'Kräver en webbkamera eller en ensam person i bild (och inte 16:9)',
      disabled: !camPossible,
    },
    {
      id: 'screen',
      label: 'Skärm med ansikte',
      hint: camPossible ? 'Skärmen upptill, personen nedtill' : 'Kräver en webbkamera eller en ensam person i bild (och inte 16:9)',
      disabled: !camPossible,
    },
    {
      id: 'group',
      label: 'Grupp',
      hint: groupSize >= 3 ? `${groupSize} personer, var och en i sin ruta` : 'Kräver 3-4 personer i bild',
      disabled: groupSize < 3,
    },
  ];
  const out = OUTPUT_SIZES[edit.aspect];
  const stackLayout = props.resolved.layout === 'facecam' || props.resolved.layout === 'screen';
  const panelValue =
    edit.panelSize ??
    (props.resolved.layout === 'facecam' && facecam ? defaultCamShare(props.source, out, facecam) : defaultScreenShare(props.source, out));

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-1.5 mb-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-gray-400 mr-auto whitespace-nowrap">Min stil</span>
        {brand.style && (
          <button
            type="button"
            onClick={applyMine}
            className="rounded-md px-2.5 py-1 text-xs font-medium bg-base-800 hover:bg-base-700"
            title="Ge klippet den sparade stilen: text, rubrik och logga"
          >
            Använd
          </button>
        )}
        <button
          type="button"
          onClick={saveAsMine}
          disabled={busy === 'style'}
          className="rounded-md px-2.5 py-1 text-xs font-medium bg-base-800 hover:bg-base-700 disabled:opacity-50"
          title="Spara klippets text, rubrik och logga som Min stil, för nya klipp"
        >
          {busy === 'style' ? 'Sparar ...' : 'Spara'}
        </button>
      </div>
      {message && (
        <p
          role="status"
          className={`mb-3 rounded-md px-3 py-2 text-xs ${message.error ? 'bg-red-500/15 text-red-200' : 'bg-accent-500/15 text-accent-300'}`}
        >
          {message.text}
        </p>
      )}
      <div className="flex gap-1 p-1 rounded-lg bg-base-900 mb-4" role="tablist">
        {(
          [
            ['text', 'Text'],
            ['layout', 'Bild'],
            ['title', 'Rubrik'],
            ['logo', 'Logga'],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`flex-1 rounded-md py-1.5 text-sm font-medium ${tab === id ? 'bg-base-700 text-white' : 'text-gray-400 hover:text-white'}`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto space-y-6 pr-1 pb-4">
        {tab === 'text' && (
          <>
            <Toggle label="Visa undertexter" checked={captions.enabled} onChange={(v) => setCaptions({ enabled: v })} />
            <Section title="Språk">
              <div className="flex gap-2">
                <select
                  aria-label="Textens språk"
                  value={translation?.lang ?? ''}
                  disabled={busy === 'translate'}
                  onChange={(e) => translateTo(e.target.value)}
                  className="min-w-0 flex-1 rounded-md bg-base-800 px-2 py-1.5 text-sm disabled:opacity-50"
                >
                  <option value="">Originalspråket</option>
                  {CAPTION_LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.label}
                    </option>
                  ))}
                </select>
                {translation && (
                  <button
                    type="button"
                    onClick={() => translateTo(translation.lang)}
                    disabled={busy === 'translate'}
                    className="rounded-md px-2.5 py-1 text-xs font-medium bg-base-800 hover:bg-base-700 disabled:opacity-50"
                    title="Översätt på nytt, till exempel efter att du ändrat klippets start eller slut"
                  >
                    Översätt igen
                  </button>
                )}
              </div>
              {busy === 'translate' && <p className="text-xs text-gray-400">Översätter ...</p>}
              {translation && (
                <details className="rounded-md bg-base-900 px-2 py-1.5">
                  <summary className="cursor-pointer text-xs text-gray-300">Rätta översättningen</summary>
                  <ul className="mt-2 space-y-2">
                    {props.sentences.map((s) => (
                      <li key={s.id} className="space-y-1">
                        <p className="text-[11px] text-gray-500">{s.text}</p>
                        <textarea
                          rows={2}
                          value={translation.segments[String(s.id)] ?? ''}
                          placeholder="Inte översatt, visas på originalspråket"
                          onChange={(e) => setSentence(s.id, e.target.value)}
                          className="w-full resize-y rounded bg-base-800 px-2 py-1 text-xs"
                        />
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </Section>
            <Section title="Stil">
              <CaptionPresetPicker
                value={captions.preset}
                onChange={(id) => set({ ...edit, captions: presetCaptions(id, captions) })}
                fontsReady={props.fontsReady}
              />
            </Section>
            <Section title="Typsnitt">
              <div className="grid grid-cols-2 gap-1.5">
                {CAPTION_FONTS.map((f) => (
                  <FontButton
                    key={f.id}
                    font={f}
                    active={captions.font === f.id}
                    fontsReady={props.fontsReady}
                    onClick={() => setCaptions({ font: f.id })}
                  />
                ))}
              </div>
              {brand.fonts.length > 0 && (
                <>
                  <p className="text-xs text-gray-400 pt-1">Dina typsnitt</p>
                  <div className="grid grid-cols-2 gap-1.5">
                    {brand.fonts.map((f) => (
                      <FontButton
                        key={f.id}
                        font={f}
                        active={captions.font === f.id}
                        fontsReady={props.fontsReady}
                        onClick={() => setCaptions({ font: f.id })}
                      />
                    ))}
                  </div>
                </>
              )}
              <FileButton accept=".ttf,.otf,font/ttf,font/otf" busy={busy === 'font'} onFile={addFont}>
                + Eget typsnitt (.ttf, .otf)
              </FileButton>
            </Section>
            <Slider
              label="Storlek"
              value={captions.size}
              min={0.5}
              max={2}
              step={0.05}
              format={(v) => `${Math.round(v * 100)} %`}
              onChange={(v, key) => setCaptions({ size: v }, key)}
            />
            <div className="space-y-1">
              <Slider
                label="Placering"
                value={captions.position ?? props.captionAuto}
                min={0.05}
                max={0.95}
                step={0.01}
                format={(v) => (captions.position === null ? 'Auto' : v < 0.34 ? 'Upptill' : v > 0.66 ? 'Nertill' : 'Mitten')}
                onChange={(v, key) => setCaptions({ position: v }, key)}
              />
              {captions.position !== null && (
                <button type="button" onClick={() => setCaptions({ position: null })} className="text-xs text-accent-300 hover:text-accent-400">
                  Automatisk placering
                </button>
              )}
            </div>
            {captions.preset !== 'word' && (
              <Slider
                label="Ord åt gången"
                value={captions.maxWords}
                min={1}
                max={8}
                step={1}
                format={(v) => String(v)}
                onChange={(v, key) => setCaptions({ maxWords: v }, key)}
              />
            )}
            <Toggle label="Versaler" checked={captions.uppercase} onChange={(v) => setCaptions({ uppercase: v })} />
            <Section title="Färger">
              <div className="space-y-3">
                <ColorField label="Text" value={captions.textColor} onChange={(v, key) => setCaptions({ textColor: v }, key)} />
                {preset.usesHighlight && (
                  <ColorField
                    label={captions.preset === 'box' ? 'Rutan' : 'Ordet som sägs'}
                    value={captions.highlightColor}
                    onChange={(v, key) => setCaptions({ highlightColor: v }, key)}
                  />
                )}
                <ColorField
                  label="Markerade ord"
                  value={captions.emphasisColor}
                  onChange={(v, key) => setCaptions({ emphasisColor: v }, key)}
                />
              </div>
            </Section>
          </>
        )}

        {tab === 'layout' && (
          <>
            <Section title="Format">
              <div className="grid grid-cols-2 gap-1.5">
                {(Object.keys(ASPECT_LABELS) as AspectRatio[]).map((a) => (
                  <button
                    key={a}
                    type="button"
                    onClick={() => set({ ...edit, aspect: a })}
                    className={`flex items-center gap-2 rounded-md border px-2 py-2 text-sm ${edit.aspect === a ? 'border-accent-500 bg-accent-500/10' : 'border-base-700 hover:border-base-600'}`}
                  >
                    <AspectIcon aspect={a} />
                    {ASPECT_LABELS[a]}
                  </button>
                ))}
              </div>
            </Section>
            <Section title="Layout">
              <div className="space-y-1.5">
                {layouts.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    disabled={l.disabled}
                    onClick={() => set({ ...edit, layout: l.id, panelSize: l.id === edit.layout ? edit.panelSize : null })}
                    className={`w-full rounded-md border px-3 py-2 text-left disabled:opacity-40 disabled:cursor-not-allowed ${edit.layout === l.id ? 'border-accent-500 bg-accent-500/10' : 'border-base-700 hover:border-base-600'}`}
                  >
                    <span className="block text-sm font-medium">{l.label}</span>
                    <span className="block text-xs text-gray-400">{l.hint}</span>
                  </button>
                ))}
              </div>
              {props.resolved.note && <p className="text-xs text-amber-300">{props.resolved.note}</p>}
            </Section>
            {props.resolved.layout === 'split' && (
              <Toggle label="Byt plats på personerna" checked={edit.splitSwap} onChange={(v) => set({ ...edit, splitSwap: v })} />
            )}
            {stackLayout && facecam && (
              <Section title={props.resolved.layout === 'facecam' ? 'Kameran' : 'Skärmen'}>
                {facecam.found === 'guess' && (
                  <p className="text-xs text-amber-300/90">
                    Hittade ingen tydlig ram runt kameran, så rutan är uppskattad runt ansiktet.
                  </p>
                )}
                <Slider
                  label={props.resolved.layout === 'facecam' ? 'Kamerans storlek' : 'Skärmens storlek'}
                  value={panelValue}
                  min={PANEL_SIZE_RANGE.min}
                  max={PANEL_SIZE_RANGE.max}
                  step={0.01}
                  format={(v) => (edit.panelSize == null ? `Auto (${Math.round(v * 100)} %)` : `${Math.round(v * 100)} %`)}
                  onChange={(v, key) => set({ ...edit, panelSize: v }, key)}
                />
                {edit.panelSize != null && (
                  <button type="button" onClick={() => set({ ...edit, panelSize: null })} className="text-xs text-accent-300 hover:text-accent-400">
                    Automatisk storlek
                  </button>
                )}
                <Toggle
                  label={props.resolved.layout === 'facecam' ? 'Kameran nedtill' : 'Skärmen nedtill'}
                  checked={edit.splitSwap}
                  onChange={(v) => set({ ...edit, splitSwap: v })}
                />
              </Section>
            )}
            {props.canCrop && props.resolved.layout === 'single' && (
              <Section title="Beskärning">
                <p className="text-xs text-gray-400">
                  Bilden följer den som pratar. Vill du bestämma själv: spola dit, tryck på Beskär och dra
                  rutan. Det gäller därifrån tills nästa ändring.
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => props.onCropMode(!props.cropMode)}
                    className={`rounded-md px-3 py-1.5 text-sm font-medium ${props.cropMode ? 'bg-accent-500 text-white' : 'bg-base-800 hover:bg-base-700'}`}
                  >
                    {props.cropMode ? 'Klar' : 'Beskär'}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      set({
                        ...edit,
                        reframe: [...edit.reframe.filter((k) => Math.abs(k.t - props.time) > 0.05), { t: props.time, cx: null }].sort(
                          (a, b) => a.t - b.t,
                        ),
                      })
                    }
                    className="rounded-md px-3 py-1.5 text-sm bg-base-800 hover:bg-base-700"
                  >
                    Följ talaren härifrån
                  </button>
                  {edit.reframe.length > 0 && (
                    <button
                      type="button"
                      onClick={() => set({ ...edit, reframe: [] })}
                      className="rounded-md px-3 py-1.5 text-sm text-gray-300 hover:text-white"
                    >
                      Återställ
                    </button>
                  )}
                </div>
                {edit.reframe.length > 0 && (
                  <ul className="space-y-1 text-sm">
                    {edit.reframe.map((key) => (
                      <li key={key.t} className="flex items-center justify-between rounded bg-base-900 px-2 py-1">
                        <span>
                          Från {formatTime(Math.max(0, key.t - edit.start))}:{' '}
                          {key.cx === null ? 'följer talaren' : `fast (${Math.round(key.cx * 100)} %)`}
                        </span>
                        <button
                          type="button"
                          onClick={() => set({ ...edit, reframe: edit.reframe.filter((k) => k !== key) })}
                          className="text-gray-400 hover:text-red-300 px-1"
                          aria-label="Ta bort"
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            )}
          </>
        )}

        {tab === 'title' && (
          <>
            <Toggle
              label="Visa rubrik överst"
              checked={edit.title.enabled}
              onChange={(v) => set({ ...edit, title: { ...edit.title, enabled: v } })}
            />
            <label className="block text-sm space-y-1">
              <span>Text</span>
              <textarea
                value={edit.title.text}
                maxLength={120}
                rows={3}
                onChange={(e) => set({ ...edit, title: { ...edit.title, text: e.target.value } }, 'title-text')}
                className="w-full rounded-lg bg-base-900 border border-base-700 px-3 py-2 text-sm focus:outline-none focus:border-accent-500"
              />
            </label>
            <Section title="Hur länge">
              <div className="flex gap-2">
                {(
                  [
                    ['intro', 'Första 3 sekunderna'],
                    ['all', 'Hela klippet'],
                  ] as ['intro' | 'all', string][]
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => set({ ...edit, title: { ...edit.title, duration: id } })}
                    className={`flex-1 rounded-md border px-2 py-1.5 text-sm ${edit.title.duration === id ? 'border-accent-500 bg-accent-500/10' : 'border-base-700 hover:border-base-600'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </Section>
            <p className="text-xs text-gray-400">
              En kort rubrik i början får fler att stanna kvar. Förslaget kommer från AI:n.
            </p>
          </>
        )}

        {tab === 'logo' && (
          <>
            {brand.logo ? (
              <>
                <div className="flex items-center gap-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={logoUrl(brand.logo.version)}
                    alt="Din logga"
                    className="h-14 w-20 object-contain rounded bg-[repeating-conic-gradient(#2a2a35_0%_25%,#1f1f28_0%_50%)] bg-[length:12px_12px]"
                  />
                  <FileButton accept="image/png,image/jpeg,image/webp" busy={busy === 'logo'} onFile={addLogo}>
                    Byt logga
                  </FileButton>
                </div>
                <Toggle label="Visa logga" checked={edit.logo.enabled} onChange={(v) => setLogo({ enabled: v })} />
                <Section title="Placering">
                  <div className="grid grid-cols-2 gap-1.5">
                    {LOGO_CORNERS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setLogo({ corner: c, enabled: true })}
                        className={`rounded-md border px-2 py-1.5 text-sm ${edit.logo.corner === c ? 'border-accent-500 bg-accent-500/10' : 'border-base-700 hover:border-base-600'}`}
                      >
                        {CORNER_LABELS[c]}
                      </button>
                    ))}
                  </div>
                </Section>
                <Slider
                  label="Storlek"
                  value={edit.logo.size}
                  min={0.06}
                  max={0.4}
                  step={0.01}
                  format={(v) => `${Math.round(v * 100)} %`}
                  onChange={(v, key) => setLogo({ size: v }, key)}
                />
                <Slider
                  label="Synlighet"
                  value={edit.logo.opacity}
                  min={0.2}
                  max={1}
                  step={0.05}
                  format={(v) => `${Math.round(v * 100)} %`}
                  onChange={(v, key) => setLogo({ opacity: v }, key)}
                />
              </>
            ) : (
              <>
                <p className="text-sm text-gray-300">
                  Lägg din logga i ett hörn av klippen. En PNG med genomskinlig bakgrund blir snyggast.
                </p>
                <FileButton accept="image/png,image/jpeg,image/webp" busy={busy === 'logo'} onFile={addLogo}>
                  Ladda upp logga
                </FileButton>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
