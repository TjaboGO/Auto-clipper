// What a clip is called on YouTube: title, description and tags from the
// AI's suggestions, cleaned up to YouTube's rules. Plain functions, shared
// by the upload form and the server.
import type { YoutubePrivacy } from './types';

export const YOUTUBE_TITLE_MAX = 100;
/** YouTube counts the description in bytes. */
export const YOUTUBE_DESCRIPTION_MAX_BYTES = 5000;
/** All tags together, as YouTube counts them. */
export const YOUTUBE_TAGS_MAX = 500;
/** Longest a Short can be. */
export const SHORTS_MAX_SECONDS = 180;

export const PRIVACY_LABELS: Record<YoutubePrivacy, string> = {
  public: 'Offentlig',
  unlisted: 'Olistad (bara med länk)',
  private: 'Privat',
};

export interface YoutubeRequest {
  title: string;
  description: string;
  tags: string[];
  privacy: YoutubePrivacy;
  /** ISO time to publish at (the video is private until then), or null for now. */
  publishAt: string | null;
}

/** Shorts are vertical or square and at most three minutes. */
export function isShort(aspect: string | undefined, durationSec: number): boolean {
  return (aspect === '9:16' || aspect === '1:1' || aspect === '4:5') && durationSec <= SHORTS_MAX_SECONDS;
}

/** YouTube doesn't allow < or > in titles and descriptions. */
function stripAngles(text: string): string {
  return text.replace(/[<>]/g, '');
}

function cutChars(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : chars.slice(0, max).join('').trimEnd();
}

const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).length;

function cutBytes(text: string, max: number): string {
  if (byteLength(text) <= max) return text;
  let out = '';
  let bytes = 0;
  for (const ch of text) {
    bytes += byteLength(ch);
    if (bytes > max) break;
    out += ch;
  }
  return out.trimEnd();
}

export function cleanTitle(raw: string): string {
  return cutChars(stripAngles(raw).replace(/\s+/g, ' ').trim(), YOUTUBE_TITLE_MAX);
}

export function cleanDescription(raw: string): string {
  return cutBytes(stripAngles(raw).replace(/\r\n?/g, '\n').trim(), YOUTUBE_DESCRIPTION_MAX_BYTES);
}

/** Tags without #, no doubles, within YouTube's total (a tag with a space counts its quotes too). */
export function cleanTags(raw: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const value of raw) {
    const tag = stripAngles(String(value)).replace(/^#+/, '').replace(/[,"]/g, '').replace(/\s+/g, ' ').trim();
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    const cost = tag.length + (tag.includes(' ') ? 2 : 0) + (out.length ? 1 : 0);
    if (total + cost > YOUTUBE_TAGS_MAX) break;
    seen.add(key);
    out.push(tag);
    total += cost;
  }
  return out;
}

/** The form's starting point for a clip: its title, caption and hashtags (and #Shorts for a Short). */
export function youtubeDefaults(
  clip: { title: string; caption: string; hashtags: string[]; durationSec: number },
  aspect?: string,
): YoutubeRequest {
  const tags = cleanTags(clip.hashtags);
  const hashtags = tags.filter((t) => !t.includes(' ')).map((t) => `#${t}`);
  if (isShort(aspect, clip.durationSec) && !hashtags.some((h) => h.toLowerCase() === '#shorts')) hashtags.push('#Shorts');
  return {
    title: cleanTitle(clip.title) || 'Klipp',
    description: cleanDescription([clip.caption.trim(), hashtags.join(' ')].filter(Boolean).join('\n\n')),
    tags,
    privacy: 'private',
    publishAt: null,
  };
}

const PRIVACIES: YoutubePrivacy[] = ['public', 'unlisted', 'private'];

/** A request from the form, checked. Returns an error message if something is wrong. */
export function sanitizeYoutubeRequest(raw: unknown, now = Date.now()): YoutubeRequest | string {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const title = cleanTitle(typeof body.title === 'string' ? body.title : '');
  if (!title) return 'Videon behöver en titel.';
  const description = cleanDescription(typeof body.description === 'string' ? body.description : '');
  const tags = cleanTags(Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === 'string') : []);
  const privacy = PRIVACIES.includes(body.privacy as YoutubePrivacy) ? (body.privacy as YoutubePrivacy) : 'private';
  let publishAt: string | null = null;
  if (typeof body.publishAt === 'string' && body.publishAt.trim()) {
    const at = Date.parse(body.publishAt);
    if (!Number.isFinite(at)) return 'Tiden för publicering går inte att läsa.';
    if (at < now + 5 * 60 * 1000) return 'Välj en tid minst fem minuter fram, eller publicera direkt.';
    if (at > now + 365 * 24 * 60 * 60 * 1000) return 'Det går att schemalägga högst ett år fram.';
    publishAt = new Date(at).toISOString();
  }
  return { title, description, tags, privacy: publishAt ? 'private' : privacy, publishAt };
}
