'use client';

import { useRef, type ReactNode } from 'react';

/** A button that opens a file picker and hands over the chosen file. */
export function FileButton(props: { accept: string; busy: boolean; children: ReactNode; onFile: (file: File) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        disabled={props.busy}
        onClick={() => input.current?.click()}
        className="rounded-md px-3 py-1.5 text-sm bg-base-800 hover:bg-base-700 disabled:opacity-50"
      >
        {props.busy ? 'Laddar upp ...' : props.children}
      </button>
      <input
        ref={input}
        type="file"
        accept={props.accept}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) props.onFile(file);
        }}
      />
    </>
  );
}
