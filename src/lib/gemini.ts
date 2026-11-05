import path from 'path';
import {
  ApiError,
  FileState,
  FinishReason,
  GoogleGenAI,
  MediaResolution,
  ThinkingLevel,
  Type,
  createPartFromUri,
  type ContentListUnion,
  type Schema,
  type ThinkingConfig,
} from '@google/genai';
import { config } from './config';
import { screenEdges } from './moments';
import { openRouterJson } from './openrouter';
import { EMOJIS, knownEmoji, MAX_EMOJIS } from './edit/emoji';
import type { Chapter, ClipScores, ClipSuggestion, PostPlatform, TranscriptSegment, VisualKind, VisualMoment } from './types';
import { cleanChapters, cleanPosts, MIN_CHAPTER_SECONDS, MIN_CHAPTERS, POST_PLATFORMS } from './chapters';
import { CAPTION_PRESETS } from './edit/presets';
import { CAPTION_FONTS } from './edit/fonts';
import { ZOOM_LEVELS } from './edit/zoom';
import { VIDEO_STYLE_CHOICES } from './edit/videoStyle';

let cachedClient: GoogleGenAI | null = null;

function client(): GoogleGenAI {
  if (!config.geminiApiKey) {
    throw new Error(
      'GEMINI_API_KEY is not set. Get a key at https://aistudio.google.com/apikey and add it to your .env file.',
    );
  }
  if (!cachedClient) {
    cachedClient = new GoogleGenAI({
      apiKey: config.geminiApiKey,
      // Retry rate limits (429) and transient server errors with backoff.
      httpOptions: { retryOptions: { attempts: 5, initialDelay: 2, maxDelay: 60 } },
    });
  }
  return cachedClient;
}

/** Gemini 3+ models take a thinking level; older models keep their defaults. */
export function thinking(model: string, level: ThinkingLevel): ThinkingConfig | undefined {
  const major = /^gemini-(\d+)/.exec(model)?.[1];
  return major && Number(major) >= 3 ? { thinkingLevel: level } : undefined;
}

/** The API's own message: an ApiError's message is sometimes the raw JSON body. */
function apiMessage(err: ApiError): string {
  try {
    const body = JSON.parse(err.message);
    if (typeof body?.error?.message === 'string') return body.error.message;
  } catch {
    // Not JSON: use it as it is.
  }
  return err.message;
}

/** Which setting names the model for a step, for error messages. */
const MODEL_SETTING: Record<string, string> = {
  transcribe: 'GEMINI_TRANSCRIBE_MODEL eller GEMINI_MODEL',
  vision: 'GEMINI_VISION_MODEL eller GEMINI_MODEL',
  highlight: 'GEMINI_HIGHLIGHT_MODEL eller GEMINI_MODEL',
};

/** Turn API errors into messages that say what to fix (shown in the UI). */
function explainError(err: unknown, model: string, step: keyof typeof MODEL_SETTING): Error {
  if (err instanceof ApiError) {
    if (err.status === 400 && /api key/i.test(err.message)) {
      return new Error('Gemini godkände inte API-nyckeln. Kolla GEMINI_API_KEY.');
    }
    if (err.status === 403) {
      return new Error(
        `Gemini nekade åtkomst (403). Kolla att API-nyckeln är giltig och får använda ${model}.`,
      );
    }
    if (err.status === 404) {
      return new Error(`Gemini hittar inte modellen "${model}". Kolla ${MODEL_SETTING[step]}.`);
    }
    if (err.status === 429) {
      return new Error('Gemini-kvoten är slut just nu (429). Vänta en stund och försök igen.');
    }
    return new Error(`Gemini svarade med fel ${err.status}: ${apiMessage(err)}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface UploadedFile {
  name: string;
  uri: string;
  mimeType: string;
}

/**
 * Upload a file to Gemini's File API and wait until it's ready to be
 * referenced in a generateContent call. Transcription gets the audio only
 * (enough, and much smaller); watching the video gets a small copy of it
 * (one frame per second, low resolution - see ffmpeg.ts).
 */
async function uploadMedia(filePath: string, mimeType: string): Promise<UploadedFile> {
  const ai = client();
  let file = await ai.files.upload({
    file: filePath,
    config: { mimeType, displayName: `auto-clipper-${path.basename(filePath)}` },
  });

  // Freshly uploaded files are processed for a while (video longer than audio).
  const deadline = Date.now() + 10 * 60 * 1000;
  while (file.state === FileState.PROCESSING && file.name) {
    if (Date.now() > deadline) {
      throw new Error('Gemini took too long to process the uploaded file.');
    }
    await sleep(2000);
    file = await ai.files.get({ name: file.name });
  }
  if (file.state === FileState.FAILED || !file.name || !file.uri) {
    throw new Error('Gemini failed to process the uploaded file.');
  }
  return { name: file.name, uri: file.uri, mimeType: file.mimeType || mimeType };
}

/** Strip ```json ... ``` fences some models add despite JSON mode, and parse. */
function parseJsonLoose<T>(raw: string): T {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced ? fenced[1] : trimmed;
  return JSON.parse(candidate) as T;
}

/**
 * Ask Gemini for JSON matching `schema`. HTTP-level failures are retried by
 * the client; this retries once more if the model returns something that
 * isn't usable JSON (cut off, empty, malformed).
 */
async function generateJson<T>(
  model: string,
  contents: ContentListUnion,
  schema: Schema,
  level: ThinkingLevel,
  mediaResolution?: MediaResolution,
): Promise<T> {
  let lastError: Error = new Error('Gemini returned no usable answer.');
  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await client().models.generateContent({
      model,
      contents,
      config: {
        responseMimeType: 'application/json',
        responseSchema: schema,
        thinkingConfig: thinking(model, level),
        mediaResolution,
      },
    });

    const blockReason = response.promptFeedback?.blockReason;
    if (blockReason) {
      throw new Error(`Gemini vägrade svara (${blockReason}).`);
    }
    const finishReason = response.candidates?.[0]?.finishReason;
    const text = response.text;
    if (finishReason === FinishReason.MAX_TOKENS) {
      lastError = new Error('Geminis svar blev avklippt (för långt). Försök med en kortare video.');
      continue;
    }
    if (!text) {
      lastError = new Error(`Gemini gav inget svar (${finishReason ?? 'okänd orsak'}).`);
      continue;
    }
    try {
      return parseJsonLoose<T>(text);
    } catch {
      lastError = new Error('Gemini svarade med ogiltig JSON.');
    }
  }
  throw lastError;
}

const transcriptSchema: Schema = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      start: { type: Type.NUMBER, description: 'Start time in seconds from the start of the audio.' },
      end: { type: Type.NUMBER, description: 'End time in seconds from the start of the audio.' },
      text: { type: Type.STRING, description: 'What is said in this segment.' },
    },
    required: ['start', 'end', 'text'],
    propertyOrdering: ['start', 'end', 'text'],
  },
};

/**
 * Transcribe one (up to ~10 minute) audio file with Gemini, returning
 * timestamped segments relative to the start of that file. Gemini's
 * timestamps are sentence/phrase-level (not guaranteed word-perfect), which
 * is what the caption renderer and highlight-picker are built to expect -
 * see captions.ts for how word timing is approximated from these segments.
 *
 * Returns an empty array if nothing is said (music, silence).
 */
export async function transcribeAudio(
  audioPath: string,
  durationSec: number,
): Promise<TranscriptSegment[]> {
  let uploaded: UploadedFile | undefined;
  try {
    uploaded = await uploadMedia(audioPath, 'audio/mp3');

    const prompt = `You are a professional transcriptionist. The attached audio is \
${durationSec.toFixed(1)} seconds long. Listen to all of it and produce a complete transcript \
broken into short natural segments (roughly one clause or sentence each, about 3-14 words).

For every segment give the start and end time in seconds measured from the very beginning of \
the audio, accurate to within half a second. Segments must be in chronological order, must not \
overlap, and must stay within 0 and ${durationSec.toFixed(1)} seconds. Cover everything that is \
said from start to finish (do not skip filler words, false starts, or cross-talk - transcribe \
what is actually said). Keep the original spoken language, do not translate. If nobody speaks, \
return an empty array.`;

    const raw = await generateJson<TranscriptSegment[]>(
      config.transcribeModel,
      [createPartFromUri(uploaded.uri, uploaded.mimeType), prompt],
      transcriptSchema,
      ThinkingLevel.LOW,
    );
    return tidySegments(Array.isArray(raw) ? raw : [], durationSec);
  } catch (err) {
    throw explainError(err, config.transcribeModel, 'transcribe');
  } finally {
    if (uploaded) {
      // Uploaded files expire on their own after 48h; this just tidies up.
      client().files.delete({ name: uploaded.name }).catch(() => undefined);
    }
  }
}

/** Sort, clamp to [0, duration] and remove overlaps, so captions never stack. */
function tidySegments(raw: TranscriptSegment[], durationSec: number): TranscriptSegment[] {
  const sorted = raw
    .filter(
      (s) =>
        s &&
        typeof s.start === 'number' &&
        typeof s.end === 'number' &&
        typeof s.text === 'string' &&
        s.text.trim().length > 0,
    )
    .map((s) => ({
      start: Math.max(0, Math.min(durationSec, s.start)),
      end: Math.max(0, Math.min(durationSec, s.end)),
      text: s.text.trim(),
    }))
    .sort((a, b) => a.start - b.start);

  const result: TranscriptSegment[] = [];
  for (const seg of sorted) {
    const prev = result[result.length - 1];
    const start = prev ? Math.max(seg.start, prev.end) : seg.start;
    if (seg.end - start < 0.05) continue;
    result.push({ ...seg, start });
  }
  return result;
}

const VISUAL_KINDS: VisualKind[] = ['action', 'reaction', 'funny', 'emotional', 'reveal', 'highlight', 'other'];

const visualSchema: Schema = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      start: { type: Type.NUMBER, description: 'Start time in seconds from the start of the video.' },
      end: { type: Type.NUMBER, description: 'End time in seconds from the start of the video.' },
      kind: { type: Type.STRING, enum: VISUAL_KINDS },
      intensity: { type: Type.INTEGER, description: '0-100: how gripping the moment is.' },
      description: { type: Type.STRING, description: 'What is seen (and heard, if it matters).' },
    },
    required: ['start', 'end', 'kind', 'intensity', 'description'],
    propertyOrdering: ['start', 'end', 'kind', 'intensity', 'description'],
  },
};

/**
 * Let Gemini watch one (up to ~10 minute) piece of the video, with its
 * sound, and list what happens on screen that could carry a short clip:
 * goals and tricks, strong reactions, funny or surprising moments, reveals.
 * Times are relative to the start of that piece. This is what finds good
 * moments in videos without talk (sports, gaming, reactions).
 */
export async function analyzeVideo(videoPath: string, durationSec: number): Promise<VisualMoment[]> {
  let uploaded: UploadedFile | undefined;
  try {
    uploaded = await uploadMedia(videoPath, 'video/mp4');
    const prompt = `You are watching a video, with its sound. It is ${durationSec.toFixed(1)} seconds \
long. You help a short-form video editor find the moments worth clipping for TikTok, Reels and \
Shorts, including in videos where nobody talks.

List the moments where something happens on screen that could carry a short clip on its own: \
actions (a goal, a trick, a crash, a win, a fail), strong reactions (laughing, shock, \
celebrating, crying), funny moments, reveals and before/after moments, impressive skills or \
demonstrations, and anything surprising. Also include calmer moments that are visually strong. \
Skip stretches where nothing happens.

For each moment:
- "start"/"end": seconds from the very beginning of this video, accurate to about a second, \
within 0 and ${durationSec.toFixed(1)}. Include the build-up, so the moment makes sense on its own.
- "kind": action, reaction, funny, emotional, reveal, highlight or other.
- "intensity": 0-100, how gripping it is for a viewer.
- "description": one sentence on what is seen (and heard, if it matters: cheering, laughter, \
music drop). Same language as any speech in the video; if nobody speaks, write in Swedish.

Moments must be in chronological order and must not overlap. Return an empty array if nothing \
worth clipping happens.`;
    const raw = await generateJson<VisualMoment[]>(
      config.visionModel,
      [createPartFromUri(uploaded.uri, uploaded.mimeType), prompt],
      visualSchema,
      ThinkingLevel.LOW,
      MediaResolution.MEDIA_RESOLUTION_LOW,
    );
    return tidyMoments(Array.isArray(raw) ? raw : [], durationSec);
  } catch (err) {
    throw explainError(err, config.visionModel, 'vision');
  } finally {
    if (uploaded) client().files.delete({ name: uploaded.name }).catch(() => undefined);
  }
}

/** Clamp to [0, duration], drop broken or overlapping items, keep them in order. */
export function tidyMoments(raw: VisualMoment[], durationSec: number): VisualMoment[] {
  const sorted = raw
    .filter((m) => m && Number.isFinite(m.start) && Number.isFinite(m.end) && typeof m.description === 'string')
    .map((m) => ({
      start: Math.max(0, Math.min(durationSec, m.start)),
      end: Math.max(0, Math.min(durationSec, m.end)),
      kind: VISUAL_KINDS.includes(m.kind) ? m.kind : ('other' as VisualKind),
      intensity: Math.max(0, Math.min(100, Math.round(Number(m.intensity) || 0))),
      description: m.description.replace(/\s+/g, ' ').trim().slice(0, 300),
    }))
    .filter((m) => m.end - m.start >= 0.5 && m.description)
    .sort((a, b) => a.start - b.start);
  const result: VisualMoment[] = [];
  for (const m of sorted) {
    const prev = result[result.length - 1];
    const start = prev ? Math.max(m.start, prev.end) : m.start;
    if (m.end - start >= 0.5) result.push({ ...m, start });
  }
  return result;
}

const emojiPickSchema: Schema = {
  type: Type.OBJECT,
  properties: { word: { type: Type.STRING }, emoji: { type: Type.STRING } },
  required: ['word', 'emoji'],
  propertyOrdering: ['word', 'emoji'],
};

/** Emoji picks with a word and an emoji there's an image for. */
function cleanEmojiPicks(raw: unknown): { word: string; emoji: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((p) => ({ word: typeof p?.word === 'string' ? p.word.trim() : '', emoji: knownEmoji(p?.emoji) }))
    .filter((p): p is { word: string; emoji: string } => !!p.word && !!p.emoji && p.word.length <= 40)
    .slice(0, MAX_EMOJIS);
}

/**
 * Emojis for a clip's words, for the editor's "Föreslå emojis": the
 * sentences of the clip in, picks of a word and an emoji out.
 */
export async function suggestEmojis(sentences: { id: number; text: string }[], seconds: number): Promise<{ word: string; emoji: string }[]> {
  const count = Math.max(1, Math.min(MAX_EMOJIS, Math.round(seconds / 10)));
  const prompt = `These sentences are said in a ${Math.round(seconds)} second short video. Pick about ${count} \
words where an emoji shown over the captions adds something (a strong feeling, money, a number, a \
reaction, food, a place). Each pick has a "word" (one single word from the sentences, copied \
exactly) and an "emoji" from this list only: ${EMOJIS.join(' ')}

${sentences.map((s) => s.text).join('\n')}`;
  const raw = await textJson<unknown>(prompt, { type: Type.ARRAY, items: emojiPickSchema }, ThinkingLevel.LOW);
  return cleanEmojiPicks(raw);
}

const brollPickSchema: Schema = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: { word: { type: Type.STRING }, query: { type: Type.STRING } },
    required: ['word', 'query'],
    propertyOrdering: ['word', 'query'],
  },
};

/**
 * Where stock video (B-roll) would show what is said in a clip: a word
 * where it starts, and an English search for a stock video site.
 */
export async function suggestBroll(sentences: { id: number; text: string }[], seconds: number): Promise<{ word: string; query: string }[]> {
  const count = Math.max(1, Math.min(4, Math.round(seconds / 15)));
  const prompt = `These sentences are said in a ${Math.round(seconds)} second short video. Pick ${count} \
moments where a few seconds of stock video (B-roll) over the speaker would show what is being \
talked about: concrete things, places, actions or feelings, not abstract words. Spread them \
over the video. Each pick has a "word" (one single word from the sentences, copied exactly, where \
the B-roll starts) and a "query": 2-4 English words to search a stock video site with \
(for example "counting money cash", "city traffic night").

${sentences.map((s) => s.text).join('\n')}`;
  const raw = await textJson<{ word?: unknown; query?: unknown }[]>(prompt, brollPickSchema, ThinkingLevel.LOW);
  return (Array.isArray(raw) ? raw : [])
    .map((p) => ({ word: typeof p?.word === 'string' ? p.word.trim() : '', query: typeof p?.query === 'string' ? p.query.trim().slice(0, 80) : '' }))
    .filter((p) => p.word && p.query)
    .slice(0, 4);
}

/** The four sub-scores, each a whole number 0-100, or undefined if any is missing. */
export function cleanScores(raw: unknown): ClipScores | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const out: Partial<ClipScores> = {};
  for (const key of ['hook', 'flow', 'value', 'trend'] as const) {
    const n = Number(r[key]);
    if (!Number.isFinite(n)) return undefined;
    out[key] = Math.max(0, Math.min(100, Math.round(n)));
  }
  return out as ClipScores;
}

const highlightSchema: Schema = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      start: { type: Type.NUMBER },
      end: { type: Type.NUMBER },
      title: { type: Type.STRING },
      caption: { type: Type.STRING },
      hashtags: { type: Type.ARRAY, items: { type: Type.STRING } },
      scores: {
        type: Type.OBJECT,
        properties: {
          hook: { type: Type.INTEGER },
          flow: { type: Type.INTEGER },
          value: { type: Type.INTEGER },
          trend: { type: Type.INTEGER },
        },
        required: ['hook', 'flow', 'value', 'trend'],
        propertyOrdering: ['hook', 'flow', 'value', 'trend'],
      },
      viralityScore: { type: Type.INTEGER },
      reason: { type: Type.STRING },
      keywords: { type: Type.ARRAY, items: { type: Type.STRING } },
      emojis: { type: Type.ARRAY, items: emojiPickSchema },
    },
    required: ['start', 'end', 'title', 'caption', 'hashtags', 'scores', 'viralityScore', 'reason', 'keywords', 'emojis'],
    propertyOrdering: ['start', 'end', 'title', 'caption', 'hashtags', 'scores', 'viralityScore', 'reason', 'keywords', 'emojis'],
  },
};

export interface HighlightOptions {
  clipCount: number;
  sourceDurationSec: number;
  /** Clip length bounds, seconds. */
  minSeconds: number;
  maxSeconds: number;
  /** "Find moments about ...": only moments about this (empty = the best moments). */
  topic?: string;
  /** Parts that are clips already (a search for more): pick something else. */
  exclude?: { start: number; end: number }[];
  /** What happens on screen (from analyzeVideo), for moments without talk. */
  visual?: VisualMoment[];
  /** The part of the video that was transcribed/watched; clips stay inside it. */
  range?: { start: number; end: number };
}

/**
 * Ask Gemini to act as a short-form video editor (Opus Clip style) and pick
 * the best self-contained moments out of a timestamped transcript - or,
 * with a topic, the best moments about that topic. Each pick comes with the
 * words to highlight in its captions.
 */
export async function findHighlights(
  transcript: TranscriptSegment[],
  opts: HighlightOptions,
): Promise<ClipSuggestion[]> {
  const transcriptText = transcript.length
    ? transcript.map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`).join('\n')
    : '(nobody speaks)';
  const visual = opts.visual ?? [];
  const visualText = visual
    .map((m) => `[${m.start.toFixed(1)}-${m.end.toFixed(1)}] ${m.kind}, intensity ${m.intensity}: ${m.description}`)
    .join('\n');
  const topic = opts.topic?.trim();
  const bounds = highlightBounds(transcript, opts);
  const covered = `${bounds.from.toFixed(0)} to ${bounds.to.toFixed(0)} seconds`;

  const task = topic
    ? `The viewer is looking for moments about: "${topic}". Pick up to ${opts.clipCount} \
moments that are clearly about that - the best, most self-contained ones. Only pick moments that \
really match; return fewer clips, or an empty array, if the video doesn't have enough of them. \
Within the matching moments, prioritize a strong hook, a complete thought and moments that make \
sense with zero outside context.`
    : `Pick the ${opts.clipCount} best, most self-contained moments to cut into standalone clips \
(fewer if the video doesn't have that many good moments). Prioritize: a strong hook in the first \
sentence, a complete thought (don't cut off mid-idea), emotional or funny or surprising or \
controversial or highly quotable moments, and moments that make sense with zero outside context.`;

  const exclude = opts.exclude?.length
    ? `\n- These parts are already clips, so don't pick anything that overlaps them: ${opts.exclude
        .map((r) => `[${r.start.toFixed(1)}-${r.end.toFixed(1)}]`)
        .join(', ')}.`
    : '';

  const snapRule = visual.length
    ? `start/end must snap to the bracketed times below (transcript segments or on-screen \
moments), so nobody is cut off mid-sentence. A clip built around something on screen may start a \
few seconds before that moment (the build-up) and end a little after it (the payoff).`
    : 'start/end must snap to the bracketed times below (transcript segments).';

  const prompt = `You are a professional short-form video editor, in the same style as Opus \
Clip: you turn long recordings (podcasts, interviews, streams) into short, highly clippable \
vertical videos for TikTok, Instagram Reels and YouTube Shorts.

Below is a timestamped transcript of a video that is ${opts.sourceDurationSec.toFixed(0)} \
seconds long in total (it covers ${covered})${visual.length ? ', and a timeline of what happens on screen, from watching the video' : ''}. ${task}${
    visual.length
      ? ` Use both: what is said, and what happens on screen - a great clip can be all \
talk, all action, or both.`
      : ''
  }

Rules:
- Each clip must be between ${opts.minSeconds} and ${opts.maxSeconds} seconds long \
(if the whole transcript is shorter than that, one clip may cover all of it).
- ${snapRule}
- Clips must not overlap each other.${exclude}
- Order the results by "viralityScore" descending.
- "title" is a short punchy label for the clip (max ~8 words).
- "caption" is a ready-to-post social caption (1-2 sentences, can include an emoji).
- "hashtags" is 3-6 relevant lowercase hashtags without the # symbol.
- "scores" rates four sides of the clip, each 0-100: "hook" (do the first three seconds make \
someone stop scrolling), "flow" (does it stand on its own, with a clear start, no dead air and a \
payoff at the end), "value" (does the viewer get something: a laugh, an insight, a feeling, a \
surprise) and "trend" (is it a topic and format people share a lot right now).
- "viralityScore" is your 0-100 estimate of how well this clip would perform, in line with the \
scores (the hook counts the most).
- "reason" is one short sentence on why you picked it${topic ? ' and how it matches what the viewer is looking for' : ''}.
- "keywords" is the words that carry the clip: about one per 5-8 seconds of clip, each a single \
word or a short phrase copied exactly as it is written in the transcript (key nouns, names, \
numbers, strong or emotional words - never filler like "och", "att", "the"). They are \
highlighted in the captions. Empty if nobody speaks in the clip.
- "emojis" go over the captions when a word is said: about one per 8-12 seconds of clip, on \
words where a picture adds something (a strong feeling, money, a number, a reaction, food, a \
place). Each has a "word" (one single word said in the clip, copied exactly from the \
transcript) and an "emoji" from this list only: ${EMOJIS.join(' ')}. Empty if nobody speaks.
- Write title, caption, hashtags and reason in the same language as the transcript (Swedish if \
nobody speaks).

Transcript:
${transcriptText}${visual.length ? `\n\nOn screen:\n${visualText}` : ''}`;

  const suggestions = await textJson<ClipSuggestion[]>(prompt, highlightSchema, ThinkingLevel.MEDIUM);
  if (!Array.isArray(suggestions)) return [];
  return cleanSuggestions(suggestions, transcript, opts);
}

/**
 * A text-only task (picking clips, translating): the highlight model on
 * Gemini, or OpenRouter when HIGHLIGHT_PROVIDER says so.
 */
async function textJson<T>(prompt: string, schema: Schema, level: ThinkingLevel): Promise<T> {
  // OpenRouter's errors already say what to fix.
  if (config.highlightProvider === 'openrouter') return openRouterJson<T>(prompt, schema);
  try {
    return await generateJson<T>(config.highlightModel, prompt, schema, level);
  } catch (err) {
    throw explainError(err, config.highlightModel, 'highlight');
  }
}

const chapterSchema: Schema = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: { start: { type: Type.NUMBER }, title: { type: Type.STRING } },
    required: ['start', 'title'],
    propertyOrdering: ['start', 'title'],
  },
};

/** Chapters for the whole video, from its transcript (for the YouTube description). */
export async function suggestChapters(transcript: TranscriptSegment[], duration: number): Promise<Chapter[]> {
  const count = Math.max(MIN_CHAPTERS, Math.min(15, Math.round(duration / 240)));
  const prompt = `Split this ${Math.round(duration)} second video into chapters for its YouTube \
description, from the timestamped transcript below. About ${count} chapters, each where a new topic \
or part starts, at least ${MIN_CHAPTER_SECONDS} seconds long. The first starts at 0. Each has a \
"start" (seconds, at the start of a transcript line) and a short "title" (2-6 words, no \
timestamps, no numbering), in the same language as the transcript.

${transcript.map((s) => `[${s.start.toFixed(1)}] ${s.text}`).join('\n')}`;
  const raw = await textJson<unknown>(prompt, chapterSchema, ThinkingLevel.LOW);
  return cleanChapters(raw, duration);
}

const postSchema: Schema = {
  type: Type.OBJECT,
  properties: Object.fromEntries(POST_PLATFORMS.map((p) => [p.id, { type: Type.STRING }])),
  required: POST_PLATFORMS.map((p) => p.id),
  propertyOrdering: POST_PLATFORMS.map((p) => p.id),
};

/** Texts to post a clip with, one per platform. */
export async function writePosts(clip: { title: string; caption: string; hashtags: string[] }, said: string): Promise<Record<PostPlatform, string>> {
  const prompt = `Write the text to post this short video with, for each platform, in the same \
language as what is said in it. Make people want to watch; don't promise what isn't in the video.

${POST_PLATFORMS.map((p) => `- "${p.id}" (${p.label}): ${p.hint}`).join('\n')}

Title: ${clip.title}
Suggested caption: ${clip.caption}
Hashtags: ${clip.hashtags.map((h) => `#${h}`).join(' ')}
What is said in the video:
${said.slice(0, 6000)}`;
  const raw = await textJson<unknown>(prompt, postSchema, ThinkingLevel.LOW);
  const posts = cleanPosts(raw);
  if (!posts) throw new Error('AI:n svarade inte med text för alla plattformar. Försök igen.');
  return posts;
}

const enumOf = (values: readonly string[]): Schema => ({ type: Type.STRING, enum: [...values] });

const videoStyleSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    name: { type: Type.STRING },
    summary: { type: Type.STRING },
    aspect: enumOf(VIDEO_STYLE_CHOICES.aspect),
    layout: enumOf(VIDEO_STYLE_CHOICES.layout),
    captions_shown: { type: Type.BOOLEAN },
    caption_preset: enumOf(CAPTION_PRESETS.map((p) => p.id)),
    caption_font: enumOf(CAPTION_FONTS.map((f) => f.id)),
    caption_uppercase: { type: Type.BOOLEAN },
    caption_words: { type: Type.INTEGER },
    caption_size: enumOf(VIDEO_STYLE_CHOICES.captionSize),
    caption_position: enumOf(VIDEO_STYLE_CHOICES.captionPosition),
    text_color: { type: Type.STRING },
    highlight_color: { type: Type.STRING },
    emphasis_color: { type: Type.STRING },
    emojis: enumOf(VIDEO_STYLE_CHOICES.emojis),
    hook_title: enumOf(VIDEO_STYLE_CHOICES.hookTitle),
    fillers_removed: { type: Type.BOOLEAN },
    pauses_removed: { type: Type.BOOLEAN },
    zoom_level: enumOf(ZOOM_LEVELS.map((z) => z.id)),
    zoom_style: enumOf(VIDEO_STYLE_CHOICES.zoomStyle),
    cut_transition: enumOf(VIDEO_STYLE_CHOICES.cutTransition),
    cut_transition_other: { type: Type.STRING },
    broll: enumOf(VIDEO_STYLE_CHOICES.broll),
    music: { type: Type.BOOLEAN },
    music_mood: { type: Type.STRING },
    music_volume: enumOf(VIDEO_STYLE_CHOICES.musicVolume),
    sound_effects: { type: Type.ARRAY, items: { type: Type.STRING } },
    progress_bar: { type: Type.BOOLEAN },
    progress_color: { type: Type.STRING },
    progress_position: enumOf(VIDEO_STYLE_CHOICES.progressPosition),
    other_effects: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
};
videoStyleSchema.required = Object.keys(videoStyleSchema.properties ?? {});
videoStyleSchema.propertyOrdering = Object.keys(videoStyleSchema.properties ?? {});

/**
 * Watch and listen to a video someone likes, and describe how it is edited
 * in our own settings (for "Mall från video"). Gemini sees the picture and
 * hears the music, sound effects and pace, which a still frame can't show.
 */
export async function analyzeVideoStyle(videoPath: string, durationSec: number): Promise<unknown> {
  let uploaded: UploadedFile | undefined;
  try {
    uploaded = await uploadMedia(videoPath, 'video/mp4');
    const prompt = `You are a short-form video editor. Watch AND listen to this ${durationSec.toFixed(0)} second \
video and describe its editing style - how it is edited, not what it is about - so that other clips \
can be edited the same way with our app. Answer only with our app's settings.

- "name": a short Swedish name for the style (2-4 words, no quotes), describing the style, not the \
person or channel. "summary": 2-3 Swedish sentences on what makes the style recognisable.
- "aspect" and "layout": the frame format, and how people are framed (follow_speaker = crop that \
follows whoever talks; full_frame = the whole picture with blurred bars; split_two = two people \
stacked; facecam_game = webcam over gameplay; screen_face = screen recording with a face; group = \
3-4 people in their own boxes).
- Captions (the burned-in subtitles): "captions_shown"; "caption_preset" the closest of: \
${CAPTION_PRESETS.map((p) => `${p.id} (${p.description})`).join('; ')}. "caption_font" the closest \
of: ${CAPTION_FONTS.map((f) => `${f.id} (${f.label})`).join(', ')}. "caption_uppercase"; \
"caption_words" how many words are on screen at once; "caption_size"; "caption_position"; \
"text_color", "highlight_color" (the word being said) and "emphasis_color" (stressed key words) \
as #RRGGBB; "emojis" how often emojis pop up over the captions.
- "hook_title": a headline at the top: none, only the first seconds, or the whole clip.
- Pace: "fillers_removed" (no eh, um ...), "pauses_removed" (tight jump cuts, no breaths between \
sentences).
- "zoom_level" and "zoom_style": punch-ins on the speaker (smooth glide or hard jump cut).
- "cut_transition" at the jump cuts: none, punch_zoom (every second part slightly closer), flash \
(a short white flash) or other (then describe it in "cut_transition_other", else leave it empty).
- "broll": how often stock footage or other images cover the speaker.
- Sound: "music" if there is background music, its "music_mood" (genre, mood, tempo, in Swedish) \
and "music_volume" under the voice; "sound_effects" every kind of sound effect you hear (whoosh, \
pop, ding, record scratch ...), in Swedish, empty if none.
- "progress_bar", "progress_color" (#RRGGBB) and "progress_position": a bar showing how far into \
the clip you are.
- "other_effects": anything else that makes the style recognisable and isn't covered above \
(colour grading, stickers, animated arrows, glitches, split text, frames ...), in Swedish, one \
short phrase each. Empty if nothing.`;
    return await generateJson<unknown>(
      config.visionModel,
      [createPartFromUri(uploaded.uri, uploaded.mimeType), prompt],
      videoStyleSchema,
      ThinkingLevel.LOW,
      MediaResolution.MEDIA_RESOLUTION_MEDIUM,
    );
  } catch (err) {
    throw explainError(err, config.visionModel, 'vision');
  } finally {
    if (uploaded) client().files.delete({ name: uploaded.name }).catch(() => undefined);
  }
}

/** Short hook titles for the top of a clip, from what is said in it. */
export async function suggestHooks(said: string, current: string): Promise<string[]> {
  const prompt = `Write 5 different hooks for the top of this short video: the line that makes \
someone stop scrolling in the first second. Each at most 8 words, in the same language as what is \
said, no hashtags, no quotes, no emojis. Mix kinds: a bold claim, a question, a number, a surprise, \
a "you" sentence. Only promise what the video delivers.${current ? ` The current hook is: ${current}` : ''}

What is said in the video:
${said.slice(0, 4000)}`;
  const raw = await textJson<unknown>(prompt, { type: Type.ARRAY, items: { type: Type.STRING } }, ThinkingLevel.LOW);
  return cleanHooks(raw);
}

/** Hooks: trimmed, without wrapping quotes, no doubles, at most 120 characters. */
export function cleanHooks(raw: unknown): string[] {
  const seen = new Set<string>();
  return (Array.isArray(raw) ? raw : [])
    .filter((h): h is string => typeof h === 'string')
    .map((h) => h.replace(/\s+/g, ' ').trim().replace(/^["'“”«»]+|["'“”«»]+$/g, '').trim().slice(0, 120))
    .filter((h) => {
      const key = h.toLowerCase();
      if (!h || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 8);
}

const translationSchema: Schema = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      id: { type: Type.INTEGER },
      text: { type: Type.STRING },
    },
    required: ['id', 'text'],
    propertyOrdering: ['id', 'text'],
  },
};

/** Sentences per request: keeps each answer far below the output limit. */
const TRANSLATE_BATCH = 120;

/**
 * Translate caption sentences into `language` (its English name), keyed
 * by sentence id. Sentences the model skips are simply missing (those
 * stay in the spoken language).
 */
export async function translateSentences(
  sentences: { id: number; text: string }[],
  language: string,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (let i = 0; i < sentences.length; i += TRANSLATE_BATCH) {
    const batch = sentences.slice(i, i + TRANSLATE_BATCH);
    const prompt = `Translate these spoken sentences from a video into ${language}, for its captions. \
They follow each other in the video, so use the context. Keep the meaning, tone and register of \
spoken language (casual stays casual), keep names and numbers, and keep each translation about as \
long as the original so it fits the same time on screen. Don't add or explain anything. If a \
sentence is already in ${language}, keep it as it is.

Answer with one item per sentence: its "id" and the translated "text".

${batch.map((s) => `${s.id}: ${s.text}`).join('\n')}`;
    const raw = await textJson<{ id: number; text: string }[]>(prompt, translationSchema, ThinkingLevel.LOW);
    const wanted = new Set(batch.map((s) => s.id));
    for (const item of Array.isArray(raw) ? raw : []) {
      if (item && Number.isInteger(item.id) && wanted.has(item.id) && typeof item.text === 'string' && item.text.trim()) {
        result[String(item.id)] = item.text.replace(/\s+/g, ' ').trim();
      }
    }
  }
  return result;
}

/**
 * Snap a time to the nearest boundary in `candidates` if one is close
 * enough. `direction` -1 only looks at earlier boundaries, 1 at later ones.
 */
function snap(time: number, candidates: number[], maxDistance: number, direction: -1 | 0 | 1 = 0): number {
  let best = time;
  let bestDistance = maxDistance;
  for (const c of candidates) {
    if (direction * (c - time) < 0) continue;
    const d = Math.abs(c - time);
    if (d < bestDistance) {
      best = c;
      bestDistance = d;
    }
  }
  return best;
}

/** Where clips may start and end: the part that was transcribed or watched. */
function highlightBounds(transcript: TranscriptSegment[], opts: HighlightOptions): { from: number; to: number } {
  if (opts.range) return { from: opts.range.start, to: Math.min(opts.sourceDurationSec, opts.range.end) };
  if (transcript.length === 0) return { from: 0, to: opts.sourceDurationSec };
  return { from: transcript[0].start, to: Math.min(opts.sourceDurationSec, transcript[transcript.length - 1].end) };
}

/**
 * Defensive cleanup of the model's picks: snap to segment and on-screen
 * moment boundaries (so a clip doesn't start or end mid-word), keep them
 * inside the part that was transcribed or watched, drop clips that are far
 * too short or overlap a better one (or an existing clip), and normalize
 * the text fields.
 */
export function cleanSuggestions(
  raw: ClipSuggestion[],
  transcript: TranscriptSegment[],
  opts: HighlightOptions,
): ClipSuggestion[] {
  const visual = opts.visual ?? [];
  const starts = [...transcript.map((s) => s.start), ...visual.map((m) => m.start)];
  const ends = [...transcript.map((s) => s.end), ...visual.map((m) => m.end)];
  const { from, to } = highlightBounds(transcript, opts);
  // A little shorter than asked is fine, a sliver is not.
  const minLength = Math.min(Math.max(5, 0.6 * opts.minSeconds), to - from);

  const candidates = raw
    .filter((c) => c && typeof c.start === 'number' && typeof c.end === 'number')
    .map((c) => {
      // An edge at something on screen only moves outward, so the build-up and payoff stay.
      const hold = screenEdges(c, visual);
      const start = Math.max(from, snap(c.start, starts, 2.5, hold.start ? -1 : 0));
      let end = Math.min(to, snap(c.end, ends, 2.5, hold.end ? 1 : 0));
      // Allow some slack over the max length, but never a runaway clip.
      if (end - start > opts.maxSeconds * 1.5) end = start + opts.maxSeconds;
      return {
        start,
        end,
        title: typeof c.title === 'string' && c.title.trim() ? c.title.trim() : 'Klipp',
        caption: typeof c.caption === 'string' ? c.caption.trim() : '',
        hashtags: Array.isArray(c.hashtags)
          ? c.hashtags
              .map((h) => String(h).replace(/^#+/, '').replace(/\s+/g, '').toLowerCase())
              .filter(Boolean)
              .slice(0, 8)
          : [],
        viralityScore: Math.max(0, Math.min(100, Math.round(Number(c.viralityScore) || 0))),
        ...(cleanScores(c.scores) ? { scores: cleanScores(c.scores) } : {}),
        reason: typeof c.reason === 'string' ? c.reason.trim() : '',
        keywords: Array.isArray(c.keywords)
          ? c.keywords
              .filter((k): k is string => typeof k === 'string')
              .map((k) => k.replace(/\s+/g, ' ').trim())
              .filter((k) => k.length > 0 && k.length <= 40)
              .slice(0, 12)
          : [],
        emojis: cleanEmojiPicks(c.emojis),
      };
    })
    .filter((c) => c.end - c.start >= minLength)
    .sort((a, b) => b.viralityScore - a.viralityScore);

  const taken = [...(opts.exclude ?? [])];
  const picked: ClipSuggestion[] = [];
  for (const c of candidates) {
    const overlaps = taken.some((p) => c.start < p.end - 0.5 && p.start < c.end - 0.5);
    if (overlaps) continue;
    picked.push(c);
    taken.push(c);
    if (picked.length >= opts.clipCount) break;
  }
  return picked;
}
