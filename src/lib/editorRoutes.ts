import { NextResponse } from 'next/server';
import { brandInfo } from './brand';
import { clipEditable, readClipEdit, readEditorData } from './editor';
import { jobStore } from './jobStore';
import { isSafeSegment } from './paths';
import type { ClipEdit, ClipEditorData } from './edit/types';
import type { Job, RenderedClip } from './types';

export interface EditableClip {
  job: Job;
  clip: RenderedClip;
  data: ClipEditorData;
  edit: ClipEdit;
}

/** Look up a clip for the editor's API routes, or the error response to send. */
export function findEditableClip(jobId: string, clipId: string): EditableClip | NextResponse {
  if (!isSafeSegment(jobId) || !isSafeSegment(clipId)) {
    return NextResponse.json({ error: 'Ogiltigt id.' }, { status: 400 });
  }
  // Your own fonts must be known before an edit that uses one is checked.
  brandInfo();
  const job = jobStore.get(jobId);
  const clip = job?.clips?.find((c) => c.id === clipId);
  if (!job || !clip) {
    return NextResponse.json({ error: 'Klippet hittades inte.' }, { status: 404 });
  }
  const data = readEditorData(jobId, clipId);
  const edit = readClipEdit(jobId, clipId);
  if (!data || !edit || !clipEditable(job, clipId)) {
    return NextResponse.json(
      {
        error: job.sourceDeletedAt
          ? 'Källvideon är borttagen, så klippet kan inte redigeras längre.'
          : 'Det här klippet kan inte redigeras.',
      },
      { status: 409 },
    );
  }
  return { job, clip, data, edit };
}
