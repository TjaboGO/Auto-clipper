// Chapters for the whole video and post texts for a clip: what the AI
// writes, cleaned up to the platforms' rules. Plain functions, no Node.
import type { Chapter, PostPlatform } from './types';

/** YouTube's rules: the first chapter at 0:00, at least three, each at least ten seconds. */
export const MIN_CHAPTERS = 3;
export const MIN_CHAPTER_SECONDS = 10;
const MAX_CHAPTERS = 40;
const MAX_CHAPTER_TITLE = 70;

/** Sorted, inside the video, far enough apart, starting at 0. Empty if fewer than three are left. */
export function cleanChapters(raw: unknown, duration: number): Chapter[] {
  const items = (Array.isArray(raw) ? raw : [])
    .map((c) => ({
      start: Number((c as { start?: unknown })?.start),
      title: String((c as { title?: unknown })?.title ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_CHAPTER_TITLE),
    }))
    .filter((c) => Number.isFinite(c.start) && c.title && c.start < duration - MIN_CHAPTER_SECONDS)
    .sort((a, b) => a.start - b.start);
  const out: Chapter[] = [];
  for (const c of items) {
    const start = out.length === 0 ? 0 : Math.round(c.start);
    if (out.length > 0 && start - out[out.length - 1].start < MIN_CHAPTER_SECONDS) continue;
    out.push({ start, title: c.title });
    if (out.length >= MAX_CHAPTERS) break;
  }
  return out.length >= MIN_CHAPTERS ? out : [];
}

/** 0:00, 4:05, 1:02:05 (hours only when the video is that long). */
export function chapterTime(seconds: number, hours: boolean): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return hours ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${Math.floor(s / 60)}:${sec}`;
}

/** The lines to paste in a YouTube description. */
export function formatChapters(chapters: Chapter[], duration: number): string {
  const hours = duration >= 3600;
  return chapters.map((c) => `${chapterTime(c.start, hours)} ${c.title}`).join('\n');
}

export const POST_PLATFORMS: { id: PostPlatform; label: string; hint: string; max: number }[] = [
  { id: 'tiktok', label: 'TikTok', hint: 'kort, med en fråga eller krok och 3-5 hashtags', max: 2200 },
  { id: 'instagram', label: 'Instagram', hint: 'några rader, emojis går bra, hashtags sist', max: 2200 },
  { id: 'youtube', label: 'YouTube Shorts', hint: 'en titelrad och en kort beskrivning med #Shorts', max: 5000 },
  { id: 'linkedin', label: 'LinkedIn', hint: 'lite längre och sakligare, med en lärdom, få hashtags', max: 3000 },
  { id: 'x', label: 'X', hint: 'en eller två meningar, högst 280 tecken', max: 280 },
];

/** Cut text to `max` characters at a word, if it's longer. */
function cutAtWord(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  const cut = chars.slice(0, max).join('');
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd();
}

/** One text per platform, trimmed to its limit. Null if any is missing. */
export function cleanPosts(raw: unknown): Record<PostPlatform, string> | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const out = {} as Record<PostPlatform, string>;
  for (const p of POST_PLATFORMS) {
    const text = typeof r[p.id] === 'string' ? (r[p.id] as string).replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim() : '';
    if (!text) return null;
    out[p.id] = cutAtWord(text, p.max);
  }
  return out;
}
