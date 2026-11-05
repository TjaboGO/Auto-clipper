'use client';

import { useState } from 'react';
import type { ClipScores } from '@/lib/types';

const PARTS: { key: keyof ClipScores; label: string; hint: string }[] = [
  { key: 'hook', label: 'Krok', hint: 'Får de första sekunderna folk att stanna?' },
  { key: 'flow', label: 'Flyt', hint: 'Står klippet på egna ben, utan döda partier, med ett slut?' },
  { key: 'value', label: 'Värde', hint: 'Får tittaren något: ett skratt, en insikt, en känsla?' },
  { key: 'trend', label: 'Trend', hint: 'Är det något folk delar mycket just nu?' },
];

/** A colour for a score: green when it's high, amber in the middle, grey when it's low. */
export function scoreColor(score: number): string {
  return score >= 80 ? 'bg-emerald-400' : score >= 60 ? 'bg-amber-400' : 'bg-gray-500';
}

/** The clip's score; click it to see what it's made of and why the clip was picked. */
export function ScoreBadge({ score, scores, reason }: { score: number; scores?: ClipScores; reason?: string }) {
  const [open, setOpen] = useState(false);
  const details = !!scores || !!reason;
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => details && setOpen((o) => !o)}
        aria-expanded={open}
        title={details ? 'Vad poängen bygger på' : 'Hur bra AI:n tror att klippet går'}
        className={`text-xs font-medium px-2 py-1 rounded-full bg-accent-500/20 text-accent-300 ${details ? 'hover:bg-accent-500/30 cursor-pointer' : 'cursor-default'}`}
      >
        {score}
      </button>
      {open && (
        <div className="absolute right-0 top-8 z-10 w-64 rounded-lg border border-base-700 bg-base-900 p-3 shadow-xl space-y-2 text-xs">
          {scores &&
            PARTS.map((p) => (
              <div key={p.key} title={p.hint}>
                <div className="flex justify-between text-gray-300">
                  <span>{p.label}</span>
                  <span>{scores[p.key]}</span>
                </div>
                <div className="h-1.5 rounded bg-base-800 overflow-hidden">
                  <div className={`h-full ${scoreColor(scores[p.key])}`} style={{ width: `${scores[p.key]}%` }} />
                </div>
              </div>
            ))}
          {reason && <p className="text-gray-400 pt-1">{reason}</p>}
        </div>
      )}
    </div>
  );
}
