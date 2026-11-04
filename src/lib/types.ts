import type { JobOptions } from './jobOptions';

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

export type VisualKind = 'action' | 'reaction' | 'funny' | 'emotional' | 'reveal' | 'highlight' | 'other';

/** Something that happens on screen, from Gemini watching the video. */
export interface VisualMoment {
  start: number; // seconds, from source video start
  end: number;
  kind: VisualKind;
  /** 0-100: how gripping it is. */
  intensity: number;
  description: string;
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
  /** What the score is made of (missing on older clips). */
  scores?: ClipScores;
  reason: string;
  /** The clip's key words (copied from the transcript), shown in the emphasis colour. */
  keywords?: string[];
  /** Emojis for strong words of the clip (each word copied from the transcript). */
  emojis?: { word: string; emoji: string }[];
}

/** Four sides of a clip, each 0-100. */
export interface ClipScores {
  /** Do the first seconds stop the scroll. */
  hook: number;
  /** Does it stand on its own, without dead air, with a payoff. */
  flow: number;
  /** Does the viewer get something out of it. */
  value: number;
  /** Is it something people share right now. */
  trend: number;
}

export interface RenderedClip extends ClipSuggestion {
  id: string;
  /** filename inside the job's output dir (a new one for every version) */
  filename: string;
  durationSec: number;
  /** 'exact': word times from Whisper. 'estimated': split from Gemini's segment times. */
  wordTiming?: 'exact' | 'estimated';
  /** How the clip is framed ('letterbox' is from older versions: the whole frame). */
  layout?: 'single' | 'split' | 'fit' | 'facecam' | 'screen' | 'group' | 'letterbox';
  /** 1 for the pipeline's render, +1 for each render from the editor. */
  version?: number;
  /** Set while a render from the editor is waiting, running or has failed. */
  renderState?: { status: 'queued' | 'rendering' | 'error'; error?: string; at: string };
  editedAt?: string;
  /** The latest upload to YouTube, if any. */
  youtube?: YoutubeUpload;
  /** Earlier finished uploads of the clip, newest first (for the calendar). */
  youtubeHistory?: YoutubeUpload[];
  /** Texts to post the clip with, written by the AI on request. */
  posts?: ClipPosts;
}

/** A chapter of the whole video, for its YouTube description. */
export interface Chapter {
  /** Seconds from the start of the video. */
  start: number;
  title: string;
}

export type PostPlatform = 'tiktok' | 'instagram' | 'youtube' | 'linkedin' | 'x';

/** Ready-to-post texts for one clip, per platform. */
export type ClipPosts = Record<PostPlatform, string> & { at: string };

export type YoutubePrivacy = 'public' | 'unlisted' | 'private';

/** A clip's upload to your YouTube channel. */
export interface YoutubeUpload {
  status: 'queued' | 'uploading' | 'done' | 'error';
  /** 0-1 while uploading. */
  progress?: number;
  title: string;
  privacy: YoutubePrivacy;
  /** When YouTube makes it public (it stays private until then). */
  publishAt?: string;
  videoId?: string;
  url?: string;
  error?: string;
  /** The clip's video file that was uploaded (a new render is a new file). */
  filename: string;
  at: string;
}

export interface JobProgressStep {
  step: JobStatus;
  message: string;
  at: string; // ISO timestamp
  /** A step that is updated in place while it's the latest one (download progress). */
  key?: string;
}

export type JobSource =
  | { type: 'upload'; originalName: string }
  /** `title`: the video's own title, once it's downloaded. */
  | { type: 'youtube'; url: string; title?: string };

export interface Job {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: JobStatus;
  source: JobSource;
  clipCount: number;
  /** What was chosen when the job was started (missing on older jobs: the defaults). */
  options?: JobOptions;
  sourceVideoPath?: string;
  sourceDurationSec?: number;
  transcript?: TranscriptSegment[];
  /** What Gemini saw when it watched the video, and which part it watched. */
  visual?: { range: { start: number; end: number }; moments: VisualMoment[] };
  suggestions?: ClipSuggestion[];
  clips?: RenderedClip[];
  progress: JobProgressStep[];
  error?: string;
  /** When the kept source video was deleted (editing is off from then on). */
  sourceDeletedAt?: string;
  /** When the job first finished; a search for more clips runs after that. */
  finishedAt?: string;
  /** Chapters of the whole video, made on request. */
  chapters?: { items: Chapter[]; at: string };
  /** How the latest search for more clips went (shown on the job page). */
  lastSearch?: { topic: string; at: string; added: number; message: string };
}
