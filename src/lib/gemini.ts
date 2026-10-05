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
import type { ClipSuggestion, TranscriptSegment, VisualKind, VisualMoment } from './types';

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
  contents: ContentListUnion,
  schema: Schema,
  level: ThinkingLevel,
  mediaResolution?: MediaResolution,
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
      [createPartFromUri(uploaded.uri, uploaded.mimeType), prompt],
      visualSchema,
      ThinkingLevel.LOW,
      MediaResolution.MEDIA_RESOLUTION_LOW,
    );
    return tidyMoments(Array.isArray(raw) ? raw : [], durationSec);
  } catch (err) {
    throw explainError(err);
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
- "viralityScore" is your 0-100 estimate of how well this clip would perform.
- "reason" is one short sentence on why you picked it${topic ? ' and how it matches what the viewer is looking for' : ''}.
- "keywords" is the words that carry the clip: about one per 5-8 seconds of clip, each a single \
word or a short phrase copied exactly as it is written in the transcript (key nouns, names, \
numbers, strong or emotional words - never filler like "och", "att", "the"). They are \
highlighted in the captions. Empty if nobody speaks in the clip.
- Write title, caption, hashtags and reason in the same language as the transcript (Swedish if \
nobody speaks).

Transcript:
${transcriptText}${visual.length ? `\n\nOn screen:\n${visualText}` : ''}`;

  let suggestions: ClipSuggestion[];
  try {
    suggestions = await generateJson<ClipSuggestion[]>(prompt, highlightSchema, ThinkingLevel.MEDIUM);
  } catch (err) {
    throw explainError(err);
  }
  if (!Array.isArray(suggestions)) return [];
  return cleanSuggestions(suggestions, transcript, opts);
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
