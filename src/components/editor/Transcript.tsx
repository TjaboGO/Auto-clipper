'use client';

import { useEffect, useRef } from 'react';
import type { ClipEdit, EditorWord } from '@/lib/edit/types';

export interface Selection {
  anchor: number;
  focus: number;
}

interface TranscriptProps {
  words: EditorWord[];
  edit: ClipEdit;
  /** Ids cut out of the video (deleted, or fillers when those are removed). */
  removed: Set<string>;
  /** Index of the word under the playhead, or -1. */
  current: number;
  selection: Selection | null;
  onSelect: (selection: Selection | null) => void;
  onSeekWord: (index: number) => void;
  editing: number | null;
  onEditing: (index: number | null) => void;
  onEditText: (index: number, text: string) => void;
}

/**
 * The clip's words, like a document: click a word to jump there, drag or
 * shift-click to select several, double-click to fix the spelling. Words
 * outside the clip are shown dimmed, so the clip can be stretched to them.
 */
export function Transcript(props: TranscriptProps) {
  const { words, edit, removed, current, selection } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<{ anchor: number; moved: boolean } | null>(null);
  const onSeekWord = useRef(props.onSeekWord);
  onSeekWord.current = props.onSeekWord;

  const from = selection ? Math.min(selection.anchor, selection.focus) : -1;
  const to = selection ? Math.max(selection.anchor, selection.focus) : -1;

  // End a drag wherever the mouse is let go. A click without dragging jumps to the word.
  useEffect(() => {
    const up = () => {
      const drag = dragging.current;
      dragging.current = null;
      if (drag && !drag.moved) onSeekWord.current(drag.anchor);
    };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);

  // Keep the word being said in view.
  useEffect(() => {
    if (current < 0 || !scrollRef.current) return;
    const el = scrollRef.current.querySelector<HTMLElement>(`[data-i="${current}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  const groups: { seg: number; items: number[] }[] = [];
  words.forEach((w, i) => {
    const last = groups[groups.length - 1];
    if (last && last.seg === w.seg) last.items.push(i);
    else groups.push({ seg: w.seg, items: [i] });
  });

  return (
    <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto pr-2 leading-8 text-[15px] select-none">
      {groups.map((group) => (
        <p key={group.seg} className="mb-3">
          {group.items.map((i) => {
            const w = words[i];
            const override = edit.words[w.id];
            const mid = (w.start + w.end) / 2;
            const inClip = mid >= edit.start && mid <= edit.end;
            const isRemoved = inClip && removed.has(w.id);
            const hidden = override?.hidden;
            const selected = i >= from && i <= to;
            const text = override?.text ?? w.text;

            let tone = 'text-gray-100';
            if (!inClip) tone = 'text-gray-600';
            else if (isRemoved) tone = 'text-red-400/70 line-through decoration-2';
            else if (hidden) tone = 'text-gray-500 underline decoration-dotted underline-offset-4';
            else if (w.filler) tone = 'italic text-amber-200/80';

            if (props.editing === i) {
              return (
                <input
                  key={w.id}
                  autoFocus
                  defaultValue={text}
                  aria-label="Rätta ordet"
                  className="mx-0.5 w-32 rounded bg-base-800 px-1 text-white outline outline-2 outline-accent-500"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') props.onEditText(i, e.currentTarget.value);
                    if (e.key === 'Escape') props.onEditing(null);
                    e.stopPropagation();
                  }}
                  onBlur={(e) => props.onEditText(i, e.currentTarget.value)}
                />
              );
            }
            return (
              <span key={w.id}>
                <span
                  data-i={i}
                  title={override?.text !== undefined ? `Ursprungligen: ${w.text}` : undefined}
                  className={`cursor-pointer rounded px-0.5 py-0.5 ${tone} ${
                    selected ? 'bg-accent-500/45' : i === current ? 'bg-white/15' : 'hover:bg-white/10'
                  } ${override?.text !== undefined ? 'border-b border-accent-400' : ''}`}
                  style={
                    override?.emphasis && inClip && !isRemoved ? { color: edit.captions.emphasisColor } : undefined
                  }
                  onMouseDown={(e) => {
                    e.preventDefault();
                    if (e.shiftKey && selection) {
                      props.onSelect({ anchor: selection.anchor, focus: i });
                      dragging.current = { anchor: selection.anchor, moved: true };
                      return;
                    }
                    props.onSelect({ anchor: i, focus: i });
                    dragging.current = { anchor: i, moved: false };
                  }}
                  onMouseEnter={() => {
                    const drag = dragging.current;
                    if (!drag || drag.anchor === i) return;
                    drag.moved = true;
                    props.onSelect({ anchor: drag.anchor, focus: i });
                  }}
                  onDoubleClick={() => props.onEditing(i)}
                >
                  {text}
                </span>{' '}
              </span>
            );
          })}
        </p>
      ))}
    </div>
  );
}
