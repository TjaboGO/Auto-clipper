import path from 'path';
import {
  ApiError,
  FileState,
  FinishReason,
  GoogleGenAI,
  ThinkingLevel,
  Type,
  createPartFromUri,
  type ContentListUnion,
  type Schema,
  type ThinkingConfig,
} from '@google/genai';
import { config } from './config';
import type { ClipSuggestion, TranscriptSegment } from './types';

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
function thinking(level: ThinkingLevel): ThinkingConfig | undefined {
  const major = /^gemini-(\d+)/.exec(config.geminiModel)?.[1];
  return major && Number(major) >= 3 ? { thinkingLevel: level } : undefined;
}

/** Turn API errors into messages that say what to fix (shown in the UI). */
function explainError(err: unknown): Error {
  if (err instanceof ApiError) {
    if (err.status === 400 && /api key/i.test(err.message)) {
      return new Error('Gemini godkände inte API-nyckeln. Kolla GEMINI_API_KEY.');
    }
    if (err.status === 403) {
      return new Error(
        `Gemini nekade åtkomst (403). Kolla att API-nyckeln är giltig och får använda ${config.geminiModel}.`,
      );
    }
    if (err.status === 404) {
      return new Error(`Gemini hittar inte modellen "${config.geminiModel}". Kolla GEMINI_MODEL.`);
    }
    if (err.status === 429) {
      return new Error('Gemini-kvoten är slut just nu (429). Vänta en stund och försök igen.');
    }
    return new Error(`Gemini svarade med fel ${err.status}: ${err.message}`);
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
 * Upload an audio file to Gemini's File API and wait until it's ready to be
 * referenced in a generateContent call. We upload audio only (not the full
 * video) - it's enough for transcription, uploads faster, and stays well
 * under Gemini's file size limits.
 */
async function uploadAudio(audioPath: string): Promise<UploadedFile> {
  const ai = client();
  let file = await ai.files.upload({
    file: audioPath,
    config: { mimeType: 'audio/mp3', displayName: `auto-clipper-${path.basename(audioPath)}` },
  });

  // Freshly uploaded files can briefly be in PROCESSING state.
  const deadline = Date.now() + 5 * 60 * 1000;
  while (file.state === FileState.PROCESSING && file.name) {
    if (Date.now() > deadline) {
      throw new Error('Gemini took too long to process the uploaded audio file.');
    }
    await sleep(2000);
    file = await ai.files.get({ name: file.name });
  }
  if (file.state === FileState.FAILED || !file.name || !file.uri) {
    throw new Error('Gemini failed to process the uploaded audio file.');
  }
  return { name: file.name, uri: file.uri, mimeType: file.mimeType || 'audio/mp3' };
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
  contents: ContentListUnion,
  schema: Schema,
  level: ThinkingLevel,
): Promise<T> {
  let lastError: Error = new Error('Gemini returned no usable answer.');
  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await client().models.generateContent({
      model: config.geminiModel,
      contents,
      config: {
        responseMimeType: 'application/json',
        responseSchema: schema,
        thinkingConfig: thinking(level),
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
    uploaded = await uploadAudio(audioPath);

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
      [createPartFromUri(uploaded.uri, uploaded.mimeType), prompt],
      transcriptSchema,
      ThinkingLevel.LOW,
    );
    return tidySegments(Array.isArray(raw) ? raw : [], durationSec);
  } catch (err) {
    throw explainError(err);
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
      viralityScore: { type: Type.INTEGER },
      reason: { type: Type.STRING },
      keywords: { type: Type.ARRAY, items: { type: Type.STRING } },
    },
    required: ['start', 'end', 'title', 'caption', 'hashtags', 'viralityScore', 'reason', 'keywords'],
    propertyOrdering: ['start', 'end', 'title', 'caption', 'hashtags', 'viralityScore', 'reason', 'keywords'],
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
  const transcriptText = transcript
    .map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`)
    .join('\n');
  const topic = opts.topic?.trim();
  const covered = transcript.length
    ? `${transcript[0].start.toFixed(0)} to ${transcript[transcript.length - 1].end.toFixed(0)} seconds`
    : '';

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

  const prompt = `You are a professional short-form video editor, in the same style as Opus \
Clip: you turn long recordings (podcasts, interviews, streams) into short, highly clippable \
vertical videos for TikTok, Instagram Reels and YouTube Shorts.

Below is a timestamped transcript of a video that is ${opts.sourceDurationSec.toFixed(0)} \
seconds long in total (the transcript covers ${covered}). ${task}

Rules:
- Each clip must be between ${opts.minSeconds} and ${opts.maxSeconds} seconds long \
(if the whole transcript is shorter than that, one clip may cover all of it).
- start/end must snap to transcript segment boundaries given below (use the bracketed times).
- Clips must not overlap each other.${exclude}
- Order the results by "viralityScore" descending.
- "title" is a short punchy label for the clip (max ~8 words).
- "caption" is a ready-to-post social caption (1-2 sentences, can include an emoji).
- "hashtags" is 3-6 relevant lowercase hashtags without the # symbol.
- "viralityScore" is your 0-100 estimate of how well this clip would perform.
- "reason" is one short sentence on why you picked it${topic ? ' and how it matches what the viewer is looking for' : ''}.
- "keywords" is the words that carry the clip: about one per 5-8 seconds of clip, each a single \
word or a short phrase copied exactly as it is written in the transcript (key nouns, names, \
numbers, strong or emotional words - never filler like "och", "att", "the"). They are \
highlighted in the captions.
- Write title, caption, hashtags and reason in the same language as the transcript.

Transcript:
${transcriptText}`;

  let suggestions: ClipSuggestion[];
  try {
    suggestions = await generateJson<ClipSuggestion[]>(prompt, highlightSchema, ThinkingLevel.MEDIUM);
  } catch (err) {
    throw explainError(err);
  }
  if (!Array.isArray(suggestions)) return [];
  return cleanSuggestions(suggestions, transcript, opts);
}

/** Snap a time to the nearest boundary in `candidates` if one is close enough. */
function snap(time: number, candidates: number[], maxDistance: number): number {
  let best = time;
  let bestDistance = maxDistance;
  for (const c of candidates) {
    const d = Math.abs(c - time);
    if (d < bestDistance) {
      best = c;
      bestDistance = d;
    }
  }
  return best;
}

/**
 * Defensive cleanup of the model's picks: snap to segment boundaries (so a
 * clip doesn't start or end mid-word), keep them inside the transcript,
 * drop clips that are far too short or overlap a better one (or an
 * existing clip), and normalize the text fields.
 */
export function cleanSuggestions(
  raw: ClipSuggestion[],
  transcript: TranscriptSegment[],
  opts: HighlightOptions,
): ClipSuggestion[] {
  const starts = transcript.map((s) => s.start);
  const ends = transcript.map((s) => s.end);
  const from = transcript.length ? transcript[0].start : 0;
  const to = transcript.length ? Math.min(opts.sourceDurationSec, transcript[transcript.length - 1].end) : opts.sourceDurationSec;
  // A little shorter than asked is fine, a sliver is not.
  const minLength = Math.min(Math.max(5, 0.6 * opts.minSeconds), to - from);

  const candidates = raw
    .filter((c) => c && typeof c.start === 'number' && typeof c.end === 'number')
    .map((c) => {
      const start = Math.max(from, snap(c.start, starts, 2.5));
      let end = Math.min(to, snap(c.end, ends, 2.5));
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
        reason: typeof c.reason === 'string' ? c.reason.trim() : '',
        keywords: Array.isArray(c.keywords)
          ? c.keywords
              .filter((k): k is string => typeof k === 'string')
              .map((k) => k.replace(/\s+/g, ' ').trim())
              .filter((k) => k.length > 0 && k.length <= 40)
              .slice(0, 12)
          : [],
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
