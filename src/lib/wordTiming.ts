import fs from 'fs';
import path from 'path';
import { config } from './config';
import { run } from './exec';
import { extractAudio } from './ffmpeg';
import type { TimedWord, TranscriptSegment } from './types';

/** A word as heard by the speech recognizer, on the source video's timeline. */
export interface HeardWord {
  text: string;
  start: number;
  end: number;
}

export interface ClipRange {
  start: number;
  end: number;
}

export interface ClipTiming extends ClipRange {
  /** Caption words with their times (source timeline). */
  words: TimedWord[];
  /** true if the times come from Whisper, false if estimated. */
  exact: boolean;
}

// Seconds of audio around each clip given to Whisper, so words at the edges
// are heard whole and the clip edges can move to real word boundaries.
const AUDIO_PAD = 1.0;
// If fewer of Gemini's words than this are heard with (nearly) the same
// text, the alignment isn't trustworthy (wrong language, music, bad audio).
const MIN_MATCH_RATIO = 0.35;
// Alignment scores.
const SCORE_SAME = 3;
const SCORE_CLOSE = 2;
const SCORE_DIFFERENT = -1;
const SCORE_GAP = -1;
const MERGE_PENALTY = 0.5;
// Words at least this similar (1 - edits/length) count as the same word
// misheard: "konsekvens"/"konsekvent", or one letter off in a short word.
const CLOSE_SIMILARITY = 0.6;
// One word matched against two joined words (a compound split differently)
// has to be at least this similar - joining makes accidental matches easy.
const MERGE_SIMILARITY = 0.8;
// Filler sounds (eh, öh, ehm, hmm, mm, uh, um...) never stand in for a word.
const FILLER = /^(?:[eöäau]+h+m*|u+m+|h+m+|m+h?m+)$/;

/** Whether a transcript word is a filler sound (the editor can cut those out). */
export function isFiller(text: string): boolean {
  return FILLER.test(normalizeWord(text));
}
const SCORE_NEVER = -5;
// Clip edges: start a little before the first word, let the last one ring
// out, and never move an edge further than MAX_EDGE_SHIFT.
const LEAD_IN = 0.12;
const TAIL_OUT = 0.35;
const MAX_EDGE_SHIFT = 2.5;
// Whisper gets this long for all clips of a job (includes the model download
// on first use) before we give up and fall back to estimated timing.
const WHISPER_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * How long a word takes to say, relative to other words: its syllables
 * (vowel groups) plus one. Speech time follows syllables much more closely
 * than letters ("utvecklingsavdelningens" is 7 syllables, not 23 letters'
 * worth). Scripts without these vowels fall back to letters.
 */
function wordWeight(text: string): number {
  const groups = text.match(/[aeiouyåäöæøéèêëáàâíìîóòôúùûü]+/giu)?.length ?? 0;
  return (groups > 0 ? groups : Math.max(1, Math.round(text.length / 3))) + 1;
}

/**
 * Estimated word times: split each transcript segment's time across its
 * words, longer words getting more (longer words take longer to say). Covers
 * every segment that overlaps the clip; the caption builder drops the rest.
 */
export function estimateWordTimings(
  transcript: TranscriptSegment[],
  clipStart: number,
  clipEnd: number,
): TimedWord[] {
  const words: TimedWord[] = [];
  transcript.forEach((segment, seg) => {
    if (segment.end <= clipStart || segment.start >= clipEnd) return;
    const texts = segment.text.trim().split(/\s+/).filter(Boolean);
    const total = texts.reduce((sum, text) => sum + wordWeight(text), 0);
    let cursor = segment.start;
    texts.forEach((text, i) => {
      const end =
        i === texts.length - 1
          ? segment.end
          : cursor + ((segment.end - segment.start) * wordWeight(text)) / total;
      words.push({ text, start: cursor, end, seg });
      cursor = end;
    });
  });
  return words;
}

/** Segments that mostly fall inside the clip - the ones its captions belong to. */
export function clipSegments(transcript: TranscriptSegment[], clip: ClipRange): Set<number> {
  const members = new Set<number>();
  transcript.forEach((segment, seg) => {
    const overlap = Math.min(segment.end, clip.end) - Math.max(segment.start, clip.start);
    if (segment.end > segment.start && overlap >= 0.5 * (segment.end - segment.start)) {
      members.add(seg);
    }
  });
  return members;
}

export function normalizeWord(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

/**
 * Same word, close (misheard ending, inflection), or different - different
 * words still score a little higher the more alike they are, so a tie goes
 * to the pairing that makes the most sense.
 */
function matchScore(a: string, b: string): number {
  if (!a || !b) return SCORE_DIFFERENT;
  if (a === b) return SCORE_SAME;
  if (FILLER.test(a) !== FILLER.test(b)) return SCORE_NEVER;
  const alike = similarity(a, b);
  return alike >= CLOSE_SIMILARITY ? SCORE_CLOSE : SCORE_DIFFERENT + 0.5 * alike;
}

function similarity(a: string, b: string): number {
  return 1 - editDistance(a, b) / Math.max(a.length, b.length);
}

/**
 * Score for one word against two joined ones, or 0 if they don't match well
 * enough. Joining has to beat either part on its own: "upp" +
 * "utvecklingsavdelningens" looks a lot like "utvecklingsavdelningenx", but
 * only because of the long word.
 */
function mergeScore(single: string, first: string, second: string): number {
  if (!single || !first || !second || FILLER.test(first) || FILLER.test(second)) return 0;
  const joined = first + second;
  if (joined === single) return SCORE_SAME;
  const joinedSimilarity = similarity(single, joined);
  const partSimilarity = Math.max(similarity(single, first), similarity(single, second));
  return joinedSimilarity >= MERGE_SIMILARITY && joinedSimilarity > partSimilarity + 0.05
    ? SCORE_CLOSE
    : 0;
}

type Move = 'pair' | 'skipWord' | 'skipHeard' | 'wordToTwo' | 'twoToHeard';

/**
 * Line Gemini's words up with the words Whisper heard and give each caption
 * word Whisper's timing. Global alignment (Needleman-Wunsch) where heard
 * words before and after the clip's text are free to skip, one word may match
 * two heard words or vice versa (compound words split differently), and
 * words Whisper missed get the time between their neighbours (placed by
 * `loudness`, the clip's audio level, when there's a pause in the gap).
 *
 * Returns null if too few words match to trust the result.
 */
export function alignWords(
  words: TimedWord[],
  heard: HeardWord[],
  loudness?: Loudness,
): TimedWord[] | null {
  const n = words.length;
  const m = heard.length;
  if (n === 0 || m === 0) return null;

  const g = words.map((w) => normalizeWord(w.text));
  const h = heard.map((w) => normalizeWord(w.text));
  const score: number[][] = [];
  const move: Move[][] = [];
  for (let i = 0; i <= n; i++) {
    score.push(new Array<number>(m + 1).fill(0));
    move.push(new Array<Move>(m + 1).fill('skipHeard'));
  }
  for (let i = 1; i <= n; i++) {
    score[i][0] = score[i - 1][0] + SCORE_GAP;
    move[i][0] = 'skipWord';
  }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      let best = score[i - 1][j - 1] + matchScore(g[i - 1], h[j - 1]);
      let bestMove: Move = 'pair';
      const consider = (value: number, candidate: Move) => {
        if (value > best) {
          best = value;
          bestMove = candidate;
        }
      };
      consider(score[i - 1][j] + SCORE_GAP, 'skipWord');
      consider(score[i][j - 1] + SCORE_GAP, 'skipHeard');
      if (j >= 2) {
        const s = mergeScore(g[i - 1], h[j - 2], h[j - 1]);
        if (s > 0) consider(score[i - 1][j - 2] + s - MERGE_PENALTY, 'wordToTwo');
      }
      if (i >= 2) {
        const s = mergeScore(h[j - 1], g[i - 2], g[i - 1]);
        if (s > 0) consider(score[i - 2][j - 1] + s - MERGE_PENALTY, 'twoToHeard');
      }
      score[i][j] = best;
      move[i][j] = bestMove;
    }
  }

  // Heard words after the clip's text are free: end wherever scores best.
  let j = 0;
  for (let k = 1; k <= m; k++) if (score[n][k] > score[n][j]) j = k;

  const times: ({ start: number; end: number } | null)[] = new Array(n).fill(null);
  // 'sure': same or close text. 'swapped': lined up with a different word.
  const kind: ('sure' | 'swapped' | null)[] = new Array(n).fill(null);
  let i = n;
  while (i > 0) {
    const step = j === 0 ? 'skipWord' : move[i][j];
    if (step === 'pair') {
      kind[i - 1] = matchScore(g[i - 1], h[j - 1]) > 0 ? 'sure' : 'swapped';
      times[i - 1] = { start: heard[j - 1].start, end: heard[j - 1].end };
      i--;
      j--;
    } else if (step === 'wordToTwo') {
      kind[i - 1] = 'sure';
      times[i - 1] = { start: heard[j - 2].start, end: heard[j - 1].end };
      i--;
      j -= 2;
    } else if (step === 'twoToHeard') {
      kind[i - 2] = kind[i - 1] = 'sure';
      const { start, end } = heard[j - 1];
      const a = wordWeight(words[i - 2].text);
      const split = start + ((end - start) * a) / (a + wordWeight(words[i - 1].text));
      times[i - 2] = { start, end: split };
      times[i - 1] = { start: split, end };
      i -= 2;
      j--;
    } else if (step === 'skipWord') {
      i--;
    } else {
      j--;
    }
  }

  const matchable = g.filter(Boolean).length || n;
  if (kind.filter((k) => k === 'sure').length / matchable < MIN_MATCH_RATIO) return null;

  const pace = speakingPace(words, times, kind);

  // A word lined up with a different heard word is only trusted when sure
  // matches pin it down on both sides (a misheard word) and the heard word is
  // about as long as this one should be. Otherwise - e.g. the last word, next
  // to context audio from the following sentence - it could be an unrelated
  // word, so it's placed between its neighbours instead.
  for (let k = 0; k < n; k++) {
    const t = times[k];
    if (
      kind[k] === 'swapped' &&
      t &&
      !(
        kind[k - 1] === 'sure' &&
        kind[k + 1] === 'sure' &&
        t.end - t.start >= 0.35 * pace * wordWeight(words[k].text)
      )
    ) {
      times[k] = null;
    }
  }

  // Remember which words got their time from a word Whisper heard, before
  // the gaps are filled in (clip edges are only tightened around those).
  const heardAt = times.map((t) => t !== null);
  fillGaps(words, times, pace, loudness);

  // Keep words in order and never overlapping.
  let previousEnd = -Infinity;
  return words.map((word, k) => {
    const t = times[k] as { start: number; end: number };
    const start = Math.max(t.start, previousEnd);
    const end = Math.max(t.end, start + 0.02);
    previousEnd = end;
    return { ...word, start, end, heard: heardAt[k] };
  });
}

/** How loud the clip's audio is over time: one RMS value per 1/rate seconds. */
export interface Loudness {
  /** Source-timeline time of values[0]. */
  offset: number;
  rate: number;
  values: Float32Array;
}

interface Span {
  start: number;
  end: number;
}

const speechLevels = new WeakMap<Float32Array, number>();

/** Loudness above which a frame counts as speech, relative to how loud the clip gets. */
function speechLevel(loudness: Loudness): number {
  let level = speechLevels.get(loudness.values);
  if (level === undefined) {
    const sorted = Float32Array.from(loudness.values).sort();
    level = Math.max(1e-6, 0.15 * (sorted[Math.floor(sorted.length * 0.9)] ?? 0));
    speechLevels.set(loudness.values, level);
  }
  return level;
}

/**
 * Stretches of speech inside [from, to]: loud frames, joined across dips
 * shorter than 80 ms. Very short bits touching either edge are left out -
 * they're the neighbouring words spilling over Whisper's word boundaries.
 */
function speechSpans(loudness: Loudness, from: number, to: number): Span[] {
  const level = speechLevel(loudness);
  const toTime = (f: number) => loudness.offset + f / loudness.rate;
  const first = Math.max(0, Math.round((from - loudness.offset) * loudness.rate));
  const last = Math.min(loudness.values.length, Math.round((to - loudness.offset) * loudness.rate));
  const spans: Span[] = [];
  let open = -1;
  let quiet = 0;
  for (let f = first; f < last; f++) {
    if (loudness.values[f] >= level) {
      if (open < 0) open = f;
      quiet = 0;
    } else if (open >= 0 && ++quiet > 8) {
      spans.push({ start: toTime(open), end: toTime(f - quiet + 1) });
      open = -1;
      quiet = 0;
    }
  }
  if (open >= 0) spans.push({ start: toTime(open), end: toTime(last - quiet) });
  return spans.filter(
    (span) =>
      span.end - span.start >= 0.05 &&
      !(span.end - span.start < 0.12 && (span.start - from < 0.03 || to - span.end < 0.03)),
  );
}

/**
 * Lay a run of words over stretches of speech, in order: one word per
 * stretch if the counts match, otherwise spread over the speech time by
 * word weight (the silence between stretches is skipped). With more
 * stretches than words, ones touching the gap's edges go first: those are
 * most likely the neighbouring words spilling over.
 */
function layOverSpans(run: TimedWord[], found: Span[], edges?: Span): Span[] {
  let spans = found;
  if (edges) {
    const touches = (span: Span) => span.start - edges.start < 0.03 || edges.end - span.end < 0.03;
    while (spans.length > run.length && touches(spans[0])) spans = spans.slice(1);
    while (spans.length > run.length && touches(spans[spans.length - 1])) spans = spans.slice(0, -1);
  }
  if (spans.length === run.length) return spans.map((span) => ({ ...span }));
  const speech = spans.reduce((sum, span) => sum + span.end - span.start, 0);
  const total = run.reduce((sum, w) => sum + wordWeight(w.text), 0);
  const at = (share: number): number => {
    let left = share * speech;
    for (const span of spans) {
      if (left <= span.end - span.start) return span.start + left;
      left -= span.end - span.start;
    }
    return spans[spans.length - 1].end;
  };
  let done = 0;
  return run.map((w) => {
    const start = at(done / total);
    done += wordWeight(w.text);
    return { start, end: at(done / total) };
  });
}

/** The speaker's pace in seconds per unit of word weight, from sure matches. */
function speakingPace(
  words: TimedWord[],
  times: ({ start: number; end: number } | null)[],
  kind: ('sure' | 'swapped' | null)[],
): number {
  const paces = words
    .map((w, k) => {
      const t = times[k];
      return kind[k] === 'sure' && t ? (t.end - t.start) / wordWeight(w.text) : 0;
    })
    .filter((pace) => pace > 0)
    .sort((a, b) => a - b);
  return Math.min(0.2, Math.max(0.04, paces[Math.floor(paces.length / 2)] ?? 0.12));
}

/**
 * Give words Whisper didn't hear a place next to their matched neighbours.
 * With the clip's audio, they're laid over the actual stretches of speech in
 * the gap (so pauses stay pauses). Without it: spread over the gap, or - if
 * the gap is clearly longer than they need - after the pause when they start
 * a sentence and before it when they end one. Missed words at the very start
 * or end of the clip lean outwards, so a clip edge set from them includes a
 * little extra rather than cutting a word off.
 */
function fillGaps(
  words: TimedWord[],
  times: ({ start: number; end: number } | null)[],
  pace: number,
  loudness?: Loudness,
): void {
  const n = words.length;
  let i = 0;
  while (i < n) {
    if (times[i]) {
      i++;
      continue;
    }
    let k = i;
    while (k < n && !times[k]) k++;
    const run = words.slice(i, k);
    const prev = i > 0 ? times[i - 1] : null;
    const next = k < n ? times[k] : null;
    const need = run.reduce((sum, w) => sum + pace * wordWeight(w.text), 0);
    let placed: Span[] | undefined;

    if (prev && next) {
      const spans = loudness ? speechSpans(loudness, prev.end, next.start) : [];
      const speech = spans.reduce((sum, span) => sum + span.end - span.start, 0);
      if (speech >= 0.3 * need) {
        placed = layOverSpans(run, spans, { start: prev.end, end: next.start });
      } else {
        let from = prev.end;
        let to = next.start;
        const room = to - from;
        if (room > need * 1.5 + 0.2) {
          const startsSentence = words[i - 1].seg !== run[0].seg;
          const endsSentence = words[k].seg !== run[run.length - 1].seg;
          from = startsSentence ? to - need : endsSentence ? from : from + (room - need) / 2;
          to = from + need;
        } else if (room < 0.08 * run.length) {
          // No room between the neighbours: borrow a little from each of them.
          const needed = 0.08 * run.length;
          const fromPrev = Math.min(0.4 * (prev.end - prev.start), (needed - room) / 2);
          prev.end -= fromPrev;
          const fromNext = Math.min(0.4 * (next.end - next.start), needed - room - fromPrev);
          next.start += fromNext;
          from = prev.end;
          to = next.start;
        }
        placed = layOverSpans(run, [{ start: from, end: to }]);
      }
    } else if (next) {
      // At the start: take stretches of speech going back from the first
      // heard word until the words fit (so the previous sentence is left out).
      const spans = loudness ? speechSpans(loudness, next.start - need - 2, next.start) : [];
      const taken: Span[] = [];
      let speech = 0;
      for (let s = spans.length - 1; s >= 0 && speech < 0.7 * need; s--) {
        taken.unshift(spans[s]);
        speech += spans[s].end - spans[s].start;
      }
      const from = Math.max(next.start - need - 1.5, Math.min(next.start - need, run[0].start));
      placed = layOverSpans(run, speech >= 0.3 * need ? taken : [{ start: from, end: next.start }]);
    } else {
      // At the end: the same going forward from the last heard word.
      const after = (prev as { end: number }).end;
      const spans = loudness ? speechSpans(loudness, after, after + need + 2) : [];
      const taken: Span[] = [];
      let speech = 0;
      for (let s = 0; s < spans.length && speech < 0.7 * need; s++) {
        taken.push(spans[s]);
        speech += spans[s].end - spans[s].start;
      }
      const to = Math.min(after + need + 1.5, Math.max(after + need, run[run.length - 1].end));
      placed = layOverSpans(run, speech >= 0.3 * need ? taken : [{ start: after, end: to }]);
    }

    placed.forEach((span, offset) => {
      times[i + offset] = span;
    });
    i = k;
  }
}

/**
 * Move the clip's edges to real word boundaries: start just before its first
 * word, end just after its last one, without cutting into the words heard
 * right outside it. An edge next to a word Whisper didn't hear is only ever
 * widened, never tightened. Keeps the original edges if they would move
 * suspiciously far (a sign the alignment went wrong at the edge).
 */
export function snapClipToWords(
  clip: ClipRange,
  words: TimedWord[],
  heard: HeardWord[],
  durationSec: number,
): ClipRange {
  if (words.length === 0) return clip;
  const first = words[0];
  const last = words[words.length - 1];

  const before = heard.filter((w) => w.end <= first.start + 0.02 && w.start < first.start - 0.02);
  const after = heard.filter((w) => w.start >= last.end - 0.02 && w.end > last.end + 0.02);
  const previousEnd = before.length > 0 ? Math.max(...before.map((w) => w.end)) : -Infinity;
  const nextStart = after.length > 0 ? Math.min(...after.map((w) => w.start)) : Infinity;

  let start = Math.max(0, first.start - LEAD_IN, Math.min(previousEnd + 0.03, first.start - 0.02));
  let end = Math.min(durationSec, last.end + TAIL_OUT, Math.max(nextStart - 0.03, last.end + 0.02));
  if (first.heard === false) start = Math.min(start, clip.start);
  if (last.heard === false) end = Math.max(end, clip.end);

  if (
    Math.abs(start - clip.start) > MAX_EDGE_SHIFT ||
    Math.abs(end - clip.end) > MAX_EDGE_SHIFT ||
    end - start < 3
  ) {
    return clip;
  }
  return { start, end };
}

/** Whether the configured Whisper model is already downloaded (first use downloads it). */
export function whisperModelIsCached(): boolean {
  const model = config.whisperModel;
  if (fs.existsSync(model)) return true; // a local model folder
  // faster-whisper's short names map to Systran's repos on Hugging Face,
  // cached as models--<org>--<name>/snapshots/<revision>/model.bin
  const repo = model.includes('/') ? model : `Systran/faster-whisper-${model}`;
  const snapshots = path.join(config.modelsDir, `models--${repo.replace('/', '--')}`, 'snapshots');
  try {
    return fs.readdirSync(snapshots, { recursive: true }).some((f) => String(f).endsWith('model.bin'));
  } catch {
    return false;
  }
}

interface WhisperResponse {
  clips?: { id: string; words?: { w: string; s: number; e: number }[]; error?: string }[];
}

/** Loudness (RMS per 10 ms) of a 16-bit PCM .wav file that starts at `offset`. */
export function readLoudness(wavPath: string, offset: number): Loudness | undefined {
  const buf = fs.readFileSync(wavPath);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return undefined;
  let rate = 0;
  let channels = 1;
  let bits = 0;
  let data: Buffer | undefined;
  for (let pos = 12; pos + 8 <= buf.length; ) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(body + 2);
      rate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(buf.length, body + size));
      break;
    }
    pos = body + size + (size % 2);
  }
  if (!data || bits !== 16 || !rate) return undefined;
  const frame = Math.round(rate / 100) * channels;
  const values = new Float32Array(Math.floor(data.length / 2 / frame));
  for (let f = 0; f < values.length; f++) {
    let sum = 0;
    for (let k = 0; k < frame; k++) {
      const sample = data.readInt16LE((f * frame + k) * 2);
      sum += sample * sample;
    }
    values[f] = Math.sqrt(sum / frame);
  }
  return { offset, rate: 100, values };
}

interface HeardClip {
  words: HeardWord[] | null;
  loudness?: Loudness;
}

/** Run Whisper once over every clip's audio (plus a little context around it). */
async function listenToClips(
  sourcePath: string,
  durationSec: number,
  clips: ClipRange[],
  workDir: string,
): Promise<HeardClip[]> {
  const requestClips: { id: string; audio: string }[] = [];
  const offsets: number[] = [];
  for (let i = 0; i < clips.length; i++) {
    const from = Math.max(0, clips[i].start - AUDIO_PAD);
    const to = Math.min(durationSec, clips[i].end + AUDIO_PAD);
    const audio = path.join(workDir, `timing_${i + 1}.wav`);
    await extractAudio(sourcePath, audio, { start: from, duration: to - from });
    requestClips.push({ id: `clip_${i + 1}`, audio });
    offsets.push(from);
  }

  const requestPath = path.join(workDir, 'timing_request.json');
  fs.writeFileSync(
    requestPath,
    JSON.stringify({ model: config.whisperModel, models_dir: config.modelsDir, clips: requestClips }),
  );
  const { stdout } = await run('python3', [config.wordTimingScript, requestPath], {}, WHISPER_TIMEOUT_MS);
  const response = JSON.parse(stdout.trim().split('\n').pop() || '{}') as WhisperResponse;

  return requestClips.map((clip, i) => {
    const result = response.clips?.find((c) => c.id === clip.id);
    if (!result || !Array.isArray(result.words)) return { words: null };
    const words = result.words
      .filter((w) => typeof w.w === 'string' && Number.isFinite(w.s) && Number.isFinite(w.e) && w.e > w.s)
      .map((w) => ({ text: w.w, start: w.s + offsets[i], end: w.e + offsets[i] }))
      .sort((a, b) => a.start - b.start);
    return { words, loudness: readLoudness(clip.audio, offsets[i]) };
  });
}

/** Pull the script's own error message out of a failed run, if there is one. */
function describeFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const reported = /\{"error": "((?:[^"\\]|\\.)*)"\}/.exec(message);
  if (reported) {
    try {
      return JSON.parse(`"${reported[1]}"`);
    } catch {
      return reported[1];
    }
  }
  return message.split('\n')[0];
}

/**
 * Exact times for a run of transcript words by listening to [start,end] of
 * the source (the editor uses this when a clip is stretched into words the
 * pipeline never listened to). Returns null if Whisper can't run or the
 * words don't line up with what it hears.
 */
export async function timeWords(opts: {
  sourcePath: string;
  durationSec: number;
  range: ClipRange;
  words: TimedWord[];
  workDir: string;
}): Promise<TimedWord[] | null> {
  if (!config.wordTiming || opts.words.length === 0) return null;
  try {
    const [heard] = await listenToClips(opts.sourcePath, opts.durationSec, [opts.range], opts.workDir);
    if (!heard.words || heard.words.length === 0) return null;
    return alignWords(opts.words, heard.words, heard.loudness);
  } catch (err) {
    console.warn('[wordTiming] Whisper failed for an edited clip, keeping estimated timing:', err);
    return null;
  }
}

export interface WordTimingResult {
  clips: ClipTiming[];
  /** Why exact timing couldn't be used at all, for the job log. */
  problem?: string;
}

/**
 * Word timing for every clip of a job. With WORD_TIMING on, Whisper listens
 * to each clip, its words are aligned to Gemini's transcript, and the clip
 * edges move to real word boundaries. Any clip where that doesn't work out
 * (and every clip, if Whisper can't run) keeps the estimated timing - this
 * never fails the job.
 */
export async function computeWordTimings(opts: {
  sourcePath: string;
  durationSec: number;
  clips: ClipRange[];
  transcript: TranscriptSegment[];
  workDir: string;
}): Promise<WordTimingResult> {
  const { sourcePath, durationSec, clips, transcript, workDir } = opts;
  const estimated: ClipTiming[] = clips.map((clip) => ({
    start: clip.start,
    end: clip.end,
    words: estimateWordTimings(transcript, clip.start, clip.end),
    exact: false,
  }));
  if (!config.wordTiming || clips.length === 0) return { clips: estimated };

  let heardPerClip: HeardClip[];
  try {
    heardPerClip = await listenToClips(sourcePath, durationSec, clips, workDir);
  } catch (err) {
    console.warn('[wordTiming] Whisper failed, using estimated timing:', err);
    return { clips: estimated, problem: describeFailure(err) };
  }

  return {
    clips: clips.map((clip, i) => {
      const { words: heard, loudness } = heardPerClip[i];
      if (!heard || heard.length === 0) return estimated[i];
      // Only whole segments: the clip keeps its sentences intact.
      const members = clipSegments(transcript, clip);
      const words = estimated[i].words.filter((w) => members.has(w.seg));
      const aligned = alignWords(words, heard, loudness);
      if (!aligned) return estimated[i];
      const edges = snapClipToWords(clip, aligned, heard, durationSec);
      return { ...edges, words: aligned, exact: true };
    }),
  };
}
