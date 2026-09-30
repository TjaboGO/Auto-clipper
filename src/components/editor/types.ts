import type { ClipEdit, ClipEditorData } from '@/lib/edit/types';
import type { RenderedClip } from '@/lib/types';

export interface PreviewInfo {
  status: 'ready' | 'pending' | 'error' | 'unavailable';
  error?: string;
  url?: string;
  peaks: { rate: number; values: number[] } | null;
}

/** What GET /api/jobs/:id/clips/:clipId/editor returns. */
export interface EditorPayload {
  job: { id: string; status: string };
  clip: RenderedClip;
  clips: { id: string; title: string }[];
  data: ClipEditorData;
  edit: ClipEdit;
  preview: PreviewInfo;
}
