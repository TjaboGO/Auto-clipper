import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleAIFileManager, FileState } from '@google/generative-ai/server';
import { config } from './config';
import type { ClipSuggestion, TranscriptSegment } from './types';

function client() {
  if (!config.geminiApiKey) {
    throw new Error(
      'GEMINI_API_KEY is not set. Get a key at https://aistudio.google.com/apikey and add it to your .env file.',
    );
  }
  return new GoogleGenerativeAI(config.geminiApiKey);
}

function fileManager() {
  if (!config.geminiApiKey) {
    throw new Error('GEMINI_API_KEY is not set.');
  }
  return new GoogleAIFileManager(config.geminiApiKey);
}

/**
 * Upload a (small) audio file to Gemini's File API and wait until it's
 * ready to be referenced in a generateContent call. We upload audio only
 * (not the full video) - it's enough for transcription + moment-picking,
 * uploads faster, and stays well under Gemini's inline/file size limits
 * even for long source videos.
 */
async function uploadAudio(audioPath: string): Promise<{ uri: string; mimeType: string }> {
  const manager = fileManager();
  const uploadResult = await manager.uploadFile(audioPath, {
    mimeType: 'audio/mp3',
    displayName: `auto-clipper-${Date.now()}`,
  });

  let file = uploadResult.file;
  // Freshly uploaded files can briefly be in PROCESSING state.
  while (file.state === FileState.PROCESSING) {
    await new Promise((r) => setTimeout(r, 2000));
    file = await manager.getFile(file.name);
  }
  if (file.state === FileState.FAILED) {
    throw new Error('Gemini failed to process the uploaded audio file.');
  }
  return { uri: file.uri, mimeType: file.mimeType };
}

/** Strip ```json ... ``` fences some models add despite JSON mode, and parse. */
function parseJsonLoose<T>(raw: string): T {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced ? fenced[1] : trimmed;
  return JSON.parse(candidate) as T;
}

/**
 * Transcribe an audio file with Gemini, returning timestamped segments
 * that cover the whole clip. Gemini's timestamps are sentence/phrase-level
 * (not guaranteed word-perfect), which is what the caption renderer and
 * highlight-picker are built to expect - see captions.ts for how word
 * timing is approximated from these segments.
 */
export async function transcribeAudio(audioPath: string): Promise<TranscriptSegment[]> {
  const { uri, mimeType } = await uploadAudio(audioPath);
  const model = client().getGenerativeModel({
    model: config.geminiModel,
    generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
  });

  const prompt = `You are a professional transcriptionist. Listen to the attached audio in full \
and produce a complete transcript broken into short natural segments (roughly one clause or \
sentence each, about 3-14 words).

For every segment give the start and end time in seconds measured from the very beginning of \
the audio, accurate to within half a second. Segments must be in chronological order, must not \
overlap, and together must cover the entire audio from start to finish (do not skip filler \
words, false starts, or cross-talk - transcribe what is actually said). Keep the original \
spoken language, do not translate.

Respond with ONLY a JSON array, no commentary, matching exactly this shape:
[{"start": 0.0, "end": 2.4, "text": "..."}, ...]`;

  const result = await model.generateContent([
    { fileData: { fileUri: uri, mimeType } },
    { text: prompt },
  ]);

  const segments = parseJsonLoose<TranscriptSegment[]>(result.response.text());
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error('Gemini returned an empty or invalid transcript.');
  }
  return segments
    .filter((s) => typeof s.start === 'number' && typeof s.end === 'number' && s.end > s.start)
    .sort((a, b) => a.start - b.start);
}

/**
 * Ask Gemini to act as a short-form video editor (Opus Clip style) and pick
 * the best self-contained moments out of a timestamped transcript.
 */
export async function findHighlights(
  transcript: TranscriptSegment[],
  opts: { clipCount: number; sourceDurationSec: number },
): Promise<ClipSuggestion[]> {
  const model = client().getGenerativeModel({
    model: config.geminiModel,
    generationConfig: { responseMimeType: 'application/json', temperature: 0.6 },
  });

  const transcriptText = transcript
    .map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`)
    .join('\n');

  const prompt = `You are a professional short-form video editor, in the same style as Opus \
Clip: you turn long recordings (podcasts, interviews, streams) into short, highly clippable \
vertical videos for TikTok, Instagram Reels and YouTube Shorts.

Below is a timestamped transcript of a video that is ${opts.sourceDurationSec.toFixed(0)} \
seconds long in total. Pick the ${opts.clipCount} best, most self-contained moments to cut into \
standalone clips. Prioritize: a strong hook in the first sentence, a complete thought (don't cut \
off mid-idea), emotional or funny or surprising or controversial or highly quotable moments, and \
moments that make sense with zero outside context.

Rules:
- Each clip must be between ${config.minClipSeconds} and ${config.maxClipSeconds} seconds long.
- start/end must snap to transcript segment boundaries given below (use the bracketed times).
- Clips must not overlap each other.
- Order the results by "viralityScore" descending.
- "title" is a short punchy label for the clip (max ~8 words).
- "caption" is a ready-to-post social caption (1-2 sentences, can include an emoji).
- "hashtags" is 3-6 relevant lowercase hashtags without the # symbol.
- "viralityScore" is your 0-100 estimate of how well this clip would perform.
- "reason" is one short sentence on why you picked it.

Transcript:
${transcriptText}

Respond with ONLY a JSON array matching exactly this shape:
[{"start": 12.0, "end": 45.0, "title": "...", "caption": "...", "hashtags": ["..."], \
"viralityScore": 87, "reason": "..."}, ...]`;

  const result = await model.generateContent(prompt);
  const suggestions = parseJsonLoose<ClipSuggestion[]>(result.response.text());
  if (!Array.isArray(suggestions) || suggestions.length === 0) {
    throw new Error('Gemini returned no clip suggestions.');
  }

  // Defensive clamping in case the model drifts outside the video bounds.
  return suggestions
    .filter((c) => typeof c.start === 'number' && typeof c.end === 'number' && c.end > c.start)
    .map((c) => ({
      ...c,
      start: Math.max(0, c.start),
      end: Math.min(opts.sourceDurationSec, c.end),
      hashtags: Array.isArray(c.hashtags) ? c.hashtags.map((h) => h.replace(/^#/, '')) : [],
      viralityScore: Math.max(0, Math.min(100, Math.round(c.viralityScore ?? 0))),
    }))
    .sort((a, b) => b.viralityScore - a.viralityScore)
    .slice(0, opts.clipCount);
}
