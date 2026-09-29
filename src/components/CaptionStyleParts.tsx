'use client';

import { captionFont, cssFontFamily } from '@/lib/edit/fonts';
import { CAPTION_PRESETS } from '@/lib/edit/presets';
import type { AspectRatio, CaptionPresetId } from '@/lib/edit/types';

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

/** The caption styles as cards, each with a sample in its own font and colours. */
export function CaptionPresetPicker(props: {
  value: CaptionPresetId;
  onChange: (id: CaptionPresetId) => void;
  fontsReady: boolean;
  columns?: string;
}) {
  return (
    <div className={`grid gap-2 ${props.columns ?? 'grid-cols-2'}`}>
      {CAPTION_PRESETS.map((p) => {
        const font = captionFont(p.style.font);
        const [first, second] = (p.style.uppercase ? 'SÅ HÄR' : 'Så här').split(' ');
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => props.onChange(p.id)}
            aria-pressed={props.value === p.id}
            className={`rounded-lg border p-2 text-left ${props.value === p.id ? 'border-accent-500 bg-accent-500/10' : 'border-base-700 hover:border-base-600 bg-base-900'}`}
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
  );
}
