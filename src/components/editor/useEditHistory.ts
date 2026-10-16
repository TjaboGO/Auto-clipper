import { useCallback, useReducer } from 'react';
import type { ClipEdit } from '@/lib/edit/types';

interface History {
  past: ClipEdit[];
  present: ClipEdit;
  future: ClipEdit[];
  /** Changes with the same key in a row (one slider drag) are one undo step. */
  lastKey: string | null;
}

type Action =
  | { type: 'set'; edit: ClipEdit; key?: string }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'reset'; edit: ClipEdit };

const LIMIT = 100;

function reducer(state: History, action: Action): History {
  switch (action.type) {
    case 'set': {
      if (action.edit === state.present) return state;
      if (action.key && action.key === state.lastKey) {
        return { ...state, present: action.edit, future: [] };
      }
      return {
        past: [...state.past, state.present].slice(-LIMIT),
        present: action.edit,
        future: [],
        lastKey: action.key ?? null,
      };
    }
    case 'undo': {
      if (state.past.length === 0) return state;
      return {
        past: state.past.slice(0, -1),
        present: state.past[state.past.length - 1],
        future: [state.present, ...state.future],
        lastKey: null,
      };
    }
    case 'redo': {
      if (state.future.length === 0) return state;
      return {
        past: [...state.past, state.present],
        present: state.future[0],
        future: state.future.slice(1),
        lastKey: null,
      };
    }
    case 'reset':
      return { past: [], present: action.edit, future: [], lastKey: null };
  }
}

/** The edit being worked on, with undo and redo. */
export function useEditHistory(initial: ClipEdit) {
  const [state, dispatch] = useReducer(reducer, { past: [], present: initial, future: [], lastKey: null });
  const set = useCallback((edit: ClipEdit, key?: string) => dispatch({ type: 'set', edit, key }), []);
  const undo = useCallback(() => dispatch({ type: 'undo' }), []);
  const redo = useCallback(() => dispatch({ type: 'redo' }), []);
  const reset = useCallback((edit: ClipEdit) => dispatch({ type: 'reset', edit }), []);
  return {
    edit: state.present,
    set,
    undo,
    redo,
    reset,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
  };
}
