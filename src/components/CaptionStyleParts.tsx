'use client';

import { captionFont, cssFontFamily } from '@/lib/edit/fonts';
import { CAPTION_PRESETS, captionPreset } from '@/lib/edit/presets';
import type { BuiltInLook } from '@/lib/edit/looks';
import type { AspectRatio, BrandStyle, CaptionPresetId, CaptionSettings, StyleTemplate } from '@/lib/edit/types';

/** A small outline in the shape of a format. */
export function AspectIcon({ aspect }: { aspect: AspectRatio }) {
  const [w, h] = aspect.split(':').map(Number);
  const scale = 18 / Math.max(w, h);
  return (
    <span className="inline-flex h-5 w-5 items-center justify-center">
      <span className="rounded-sm border-2 border-current" style={{ width: w * scale, height: h * scale }} />
    </span>
  );
}

/** "Så här" in a caption style's font and colours, the word being said highlighted. */
export function StyleSample(props: { style: Pick<CaptionSettings, 'preset' | 'font' | 'textColor' | 'highlightColor' | 'uppercase'>; fontsReady: boolean }) {
  const { style } = props;
  const font = captionFont(style.font);
  const preset = captionPreset(style.preset);
  const [first, second] = (style.uppercase ? 'SÅ HÄR' : 'Så här').split(' ');
  return (
    <span
      className="block text-lg leading-7 truncate"
      style={{
        fontFamily: props.fontsReady ? `"${cssFontFamily(font)}"` : undefined,
        color: style.textColor,
        textShadow:
          style.preset === 'neon'
            ? `0 0 2px ${style.highlightColor}, 0 0 6px ${style.highlightColor}, 0 0 10px ${style.highlightColor}`
            : '0 0 3px #000, 0 0 2px #000, 2px 2px 0 rgba(0,0,0,.6)',
      }}
    >
      {first}{' '}
      <span
        style={
          style.preset === 'box'
            ? { background: style.highlightColor, padding: '0 4px' }
            : style.preset === 'reveal'
              ? { opacity: 0.25 }
              : preset.usesHighlight && style.preset !== 'neon'
                ? { color: style.highlightColor }
                : undefined
        }
      >
        {style.preset === 'word' ? '' : second}
      </span>
    </span>
  );
}

/**
 * The caption styles as cards, each with a sample in its own font and
 * colours. With `mine`, "Min stil" (your saved style) comes first.
 */
export function CaptionPresetPicker(props: {
  value: string;
  onChange: (id: CaptionPresetId) => void;
  fontsReady: boolean;
  columns?: string;
  mine?: { style: BrandStyle; onSelect: () => void } | null;
  /** Your templates, after Min stil. */
  templates?: { template: StyleTemplate; onSelect: () => void }[];
  /** The app's own looks, after your templates. */
  looks?: { look: BuiltInLook; onSelect: () => void }[];
}) {
  const card = (selected: boolean) =>
    `rounded-lg border p-2 text-left ${selected ? 'border-accent-500 bg-accent-500/10' : 'border-base-700 hover:border-base-600 bg-base-900'}`;
  return (
    <div className={`grid gap-2 ${props.columns ?? 'grid-cols-2'}`}>
      {props.mine && (
        <button type="button" onClick={props.mine.onSelect} aria-pressed={props.value === 'mine'} className={card(props.value === 'mine')}>
          <StyleSample style={props.mine.style.captions} fontsReady={props.fontsReady} />
          <span className="block text-xs font-medium mt-1">Min stil</span>
          <span className="block text-[11px] text-gray-400 leading-tight">Din sparade stil, med logga om du har en</span>
        </button>
      )}
      {(props.templates ?? []).map(({ template, onSelect }) => (
        <button key={template.id} type="button" onClick={onSelect} aria-pressed={props.value === template.id} className={card(props.value === template.id)}>
          <StyleSample style={template.captions} fontsReady={props.fontsReady} />
          <span className="block text-xs font-medium mt-1 truncate">{template.name}</span>
          <span className="block text-[11px] text-gray-400 leading-tight">Din mall</span>
        </button>
      ))}
      {(props.looks ?? []).map(({ look, onSelect }) => (
        <button key={look.id} type="button" onClick={onSelect} aria-pressed={props.value === look.id} className={card(props.value === look.id)}>
          <StyleSample style={look.style.captions} fontsReady={props.fontsReady} />
          <span className="block text-xs font-medium mt-1 truncate">{look.name}</span>
          <span className="block text-[11px] text-gray-400 leading-tight">{look.description}</span>
        </button>
      ))}
      {CAPTION_PRESETS.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => props.onChange(p.id)}
          aria-pressed={props.value === p.id}
          className={card(props.value === p.id)}
        >
          <StyleSample style={{ preset: p.id, ...p.style }} fontsReady={props.fontsReady} />
          <span className="block text-xs font-medium mt-1">{p.label}</span>
          <span className="block text-[11px] text-gray-400 leading-tight">{p.description}</span>
        </button>
      ))}
    </div>
  );
}
