// Helpers for what Gemini saw on screen (see analyzeVideo in gemini.ts).
// Plain TypeScript, no I/O, so it's easy to test.
import type { TranscriptSegment, VisualMoment } from './types';

/** Seconds before an on-screen moment that lead up to it, and after it that belong to it. */
const BUILD_UP_SECONDS = 5;
const PAYOFF_SECONDS = 5;

/** How much of [start, end] has someone talking (0..1). */
export function speechShare(transcript: TranscriptSegment[], range: { start: number; end: number }): number {
  const talk = transcript.reduce(
    (sum, s) => sum + Math.max(0, Math.min(s.end, range.end) - Math.max(s.start, range.start)),
    0,
  );
  return talk / Math.max(1, range.end - range.start);
}

/**
 * Which of a clip's edges sit at something happening on screen: the start
 * in the build-up to (or inside) an on-screen moment, the end inside (or
 * right after) one. Those edges may be moved outward to a word or moment
 * boundary, but never inward, or the clip would lose its build-up or
 * payoff. Edges in plain talk can be tightened as usual.
 */
export function screenEdges(
  clip: { start: number; end: number },
  moments: VisualMoment[],
): { start: boolean; end: boolean } {
  return {
    start: moments.some((m) => clip.start >= m.start - BUILD_UP_SECONDS && clip.start <= m.end),
    end: moments.some((m) => clip.end >= m.start && clip.end <= m.end + PAYOFF_SECONDS),
  };
}
