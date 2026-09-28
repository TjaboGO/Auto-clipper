'use client';

import { useRef, useState, type ReactNode } from 'react';
import { CAPTION_FONTS, captionFont, cssFontFamily } from '@/lib/edit/fonts';
import { ASPECT_LABELS, splitAllowed, type ResolvedLayout } from '@/lib/edit/layout';
import { CAPTION_PRESETS, captionPreset, presetCaptions } from '@/lib/edit/presets';
import type {
  AspectRatio,
  CaptionSettings,
  ClipEdit,
  FramingAnalysis,
  LayoutMode,
} from '@/lib/edit/types';
import { formatTime } from './format';

type Tab = 'text' | 'layout' | 'title';

interface SettingsPanelProps {
  edit: ClipEdit;
  set: (edit: ClipEdit, key?: string) => void;
  analysis: FramingAnalysis | null;
  resolved: { layout: ResolvedLayout; note?: string };
  /** Whether manual framing makes sense (the crop moves sideways). */
  canCrop: boolean;
  cropMode: boolean;
  onCropMode: (on: boolean) => void;
  /** Playhead, source time. */
  time: number;
  fontsReady: boolean;
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

function AspectIcon({ aspect }: { aspect: AspectRatio }) {
  const [w, h] = aspect.split(':').map(Number);
  const scale = 18 / Math.max(w, h);
  return (
    <span className="inline-flex h-5 w-5 items-center justify-center">
      <span className="rounded-sm border-2 border-current" style={{ width: w * scale, height: h * scale }} />
    </span>
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

  const layouts: { id: LayoutMode; label: string; hint: string; disabled?: boolean }[] = [
    { id: 'auto', label: 'Auto', hint: 'Följer den som pratar, split screen vid snabba växlingar' },
    { id: 'fill', label: 'Följ talaren', hint: 'Beskär runt den som pratar' },
    { id: 'fit', label: 'Hela bilden', hint: 'Hela videon, suddig bakgrund runt om' },
    {
      id: 'split',
      label: 'Split screen',
      hint: splitPossible ? 'Två personer, en upptill och en nedtill' : 'Kräver två personer i bild (och inte 16:9)',
      disabled: !splitPossible,
    },
  ];

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex gap-1 p-1 rounded-lg bg-base-900 mb-4" role="tablist">
        {(
          [
            ['text', 'Text'],
            ['layout', 'Bild'],
            ['title', 'Rubrik'],
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
            <Section title="Stil">
              <div className="grid grid-cols-2 gap-2">
                {CAPTION_PRESETS.map((p) => {
                  const font = captionFont(p.style.font);
                  const sample = p.style.uppercase ? 'SÅ HÄR' : 'Så här';
                  const [first, second] = sample.split(' ');
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => set({ ...edit, captions: presetCaptions(p.id, captions) })}
                      className={`rounded-lg border p-2 text-left ${captions.preset === p.id ? 'border-accent-500 bg-accent-500/10' : 'border-base-700 hover:border-base-600 bg-base-900'}`}
                    >
                      <span
                        className="block text-lg leading-7 truncate"
                        style={{
                          fontFamily: props.fontsReady ? `"${cssFontFamily(font)}"` : undefined,
                          color: p.style.textColor,
                          textShadow: '0 0 3px #000, 0 0 2px #000, 2px 2px 0 rgba(0,0,0,.6)',
                        }}
                      >
                        {first}{' '}
                        <span
                          style={
                            p.id === 'box'
                              ? { background: p.style.highlightColor, padding: '0 4px' }
                              : p.usesHighlight
                                ? { color: p.style.highlightColor }
                                : undefined
                          }
                        >
                          {p.id === 'word' ? '' : second}
                        </span>
                      </span>
                      <span className="block text-xs font-medium mt-1">{p.label}</span>
                      <span className="block text-[11px] text-gray-400 leading-tight">{p.description}</span>
                    </button>
                  );
                })}
              </div>
            </Section>
            <Section title="Typsnitt">
              <div className="grid grid-cols-2 gap-1.5">
                {CAPTION_FONTS.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setCaptions({ font: f.id })}
                    className={`rounded-md border px-2 py-1.5 text-left text-sm truncate ${captions.font === f.id ? 'border-accent-500 bg-accent-500/10' : 'border-base-700 hover:border-base-600'}`}
                    style={{ fontFamily: props.fontsReady ? `"${cssFontFamily(f)}"` : undefined }}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
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
                value={captions.position ?? (props.resolved.layout === 'split' ? 0.5 : 0.72)}
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
                    onClick={() => set({ ...edit, layout: l.id })}
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
      </div>
    </div>
  );
}
