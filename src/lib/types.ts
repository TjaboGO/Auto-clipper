export type JobStatus =
  | 'queued'
  | 'downloading'
  | 'transcribing'
  | 'analyzing'
  | 'rendering'
  | 'done'
  | 'error';

export interface TranscriptSegment {
  start: number; // seconds, from source video start
  end: number; // seconds
  text: string;
}

/** One caption word with its time on the source video's timeline. */
export interface TimedWord {
  text: string;
  start: number; // seconds, from source video start
  end: number; // seconds
  /** Index of the transcript segment it came from - a caption page never spans two. */
  seg: number;
  /** Word timing only: false if Whisper didn't hear it and its time was filled in. */
  heard?: boolean;
}

/** A moment Gemini picked out of the transcript as worth clipping. */
export interface ClipSuggestion {
  start: number;
  end: number;
  title: string;
  caption: string;
  hashtags: string[];
  /** 0-100, how likely Gemini thinks this clip is to perform well. */
  viralityScore: number;
  reason: string;
}

export interface RenderedClip extends ClipSuggestion {
  id: string;
  /** filename inside the job's output dir */
  filename: string;
  durationSec: number;
  /** 'exact': word times from Whisper. 'estimated': split from Gemini's segment times. */
  wordTiming?: 'exact' | 'estimated';
}

export interface JobProgressStep {
  step: JobStatus;
  message: string;
  at: string; // ISO timestamp
}

export type JobSource =
  | { type: 'upload'; originalName: string }
  | { type: 'youtube'; url: string };

export interface Job {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: JobStatus;
  source: JobSource;
  clipCount: number;
  sourceVideoPath?: string;
  sourceDurationSec?: number;
  transcript?: TranscriptSegment[];
  suggestions?: ClipSuggestion[];
  clips?: RenderedClip[];
  progress: JobProgressStep[];
  error?: string;
}
