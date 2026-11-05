// Emojis over the captions (Opus calls them AI emojis): one shows above the
// text when its word is said, popping in, and stays until that caption page
// is done. The images are the same PNGs in the preview and the render
// (assets/emoji, rendered from Noto Color Emoji), so they look alike
// everywhere.
import type { CaptionMetrics, CaptionPage } from './captionLayout';
import type { OutputWord } from './timeline';
import type { ClipEdit } from './types';

/** The emojis there are images for. */
export const EMOJIS = (
  '😂 🤣 😅 😊 😍 🥰 😎 🤔 🤯 😱 😮 😢 😭 😡 🤬 😤 🙄 😬 🥺 😴 🤩 🥳 😇 🤑 🤫 😏 🙈 💀 👀 🤡 ' +
  '👍 👎 👏 🙌 🙏 💪 🤝 ✌️ 👌 🤞 👉 ☝️ ❤️ 💔 🔥 💯 ✨ ⭐ 💥 ⚡ ✅ ❌ ⚠️ ❗ ❓ 💡 🎯 🚀 📈 📉 💰 💸 🏆 🥇 🎉 🎁 ' +
  '📱 💻 🎮 🎧 🎤 🎬 📸 📚 🧠 ⏰ ⌛ 🔑 🔒 📌 🛒 🍕 🍔 ☕ 🍺 🏠 🚗 ✈️ 🌍 ☀️ ❄️ 🌈 🐶 🐱 ⚽ 🏀 🎵 💼 💊 👶 👑 💎 🤖 ' +
  '👻 🎂 🏃 🤷 🙋 🤦 💤 🆕 🔴 🟢'
).split(' ');

const bare = (emoji: string) => emoji.replace(/️/g, '');
const BY_BARE = new Map(EMOJIS.map((e) => [bare(e), e]));

/** The emoji as listed in EMOJIS (with its variation selector), or null if there's no image for it. */
export function knownEmoji(value: unknown): string | null {
  return typeof value === 'string' ? BY_BARE.get(bare(value.trim())) ?? null : null;
}

/** The image's file name: code points in hex, joined by "-" (no variation selector). */
export function emojiFile(emoji: string): string {
  return `${[...emoji]
    .map((c) => c.codePointAt(0) as number)
    .filter((cp) => cp !== 0xfe0f)
    .map((cp) => cp.toString(16))
    .join('-')}.png`;
}

/** The emojis put on words: word id -> emoji. */
export function wordEmojis(edit: Pick<ClipEdit, 'words'>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, o] of Object.entries(edit.words)) if (o.emoji) out[id] = o.emoji;
  return out;
}

export interface EmojiShow {
  emoji: string;
  start: number;
  end: number;
}

/** How long an emoji takes to pop in, and how far it rises meanwhile (share of its size). */
export const EMOJI_POP = 0.12;
export const EMOJI_RISE = 0.18;
const MIN_SHOW = 0.6;
const MAX_SHOW = 2.5;
/** At most this many emojis in one clip (each is a picture layer in the render). */
export const MAX_EMOJIS = 16;

/**
 * When each emoji is on screen (clip timeline): from its word on, until the
 * caption page on screen then is done (or the next emoji comes). `words`
 * are the spoken words (with ids), `pages` what the captions show - the
 * same words, or their translation.
 */
export function emojiShows(
  words: OutputWord[],
  emojis: Record<string, string>,
  pages: CaptionPage[],
  clipLength: number,
): EmojiShow[] {
  const starts = words
    .filter((w) => knownEmoji(emojis[w.id]))
    .map((w) => ({ emoji: knownEmoji(emojis[w.id]) as string, start: w.start }))
    .sort((a, b) => a.start - b.start)
    .slice(0, MAX_EMOJIS);
  return starts
    .map((s, i) => {
      const page = pages.find((p) => s.start >= p[0].start - 0.05 && s.start < p[p.length - 1].until);
      let end = page ? page[page.length - 1].until : s.start + MIN_SHOW;
      end = Math.min(Math.max(end, s.start + MIN_SHOW), s.start + MAX_SHOW, clipLength);
      const next = starts[i + 1];
      if (next) end = Math.min(end, next.start);
      return { emoji: s.emoji, start: s.start, end };
    })
    .filter((s) => s.end - s.start >= 0.2);
}

/** The clip's emojis, if its captions show them. `spoken`: the spoken words; `pages`: what the captions show. */
export function clipEmojiShows(
  edit: Pick<ClipEdit, 'words' | 'captions'>,
  spoken: OutputWord[],
  pages: CaptionPage[],
  clipLength: number,
): EmojiShow[] {
  if (!edit.captions.enabled || edit.captions.emojis === false) return [];
  return emojiShows(spoken, wordEmojis(edit), pages, clipLength);
}

/** Where the emoji goes: centered just above a two-line caption, a bit bigger than the text. */
export function emojiRect(m: CaptionMetrics): { x: number; y: number; size: number } {
  const size = Math.round(m.fontSize * 1.15);
  const bottom = m.centerY - m.fontSize * 1.1;
  return { x: Math.round(m.centerX - size / 2), y: Math.round(bottom - size), size };
}

/** The pop-in at `elapsed` seconds after the emoji appears: opacity, and how far below its place it still is (px). */
export function emojiPop(elapsed: number, size: number): { alpha: number; dy: number } {
  const k = Math.max(0, Math.min(1, elapsed / EMOJI_POP));
  return { alpha: k, dy: Math.round(EMOJI_RISE * size * (1 - k)) };
}
