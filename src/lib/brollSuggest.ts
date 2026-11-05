// AI B-roll for a clip: the AI picks words and English searches, the best
// Pexels result for each is downloaded and put on that word.
import { pickWordIds } from './editorWords';
import { suggestBroll } from './gemini';
import { downloadVideo, searchVideos } from './pexels';
import { BROLL_DURATION } from './edit/presets';
import { clipWords, keptRanges, outputDuration } from './edit/timeline';
import { sentencesToTranslate } from './edit/translation';
import type { AspectRatio, BrollItem, ClipEdit, EditorWord } from './edit/types';

export function orientationFor(aspect: AspectRatio): 'portrait' | 'landscape' | 'square' {
  return aspect === '16:9' ? 'landscape' : aspect === '1:1' ? 'square' : 'portrait';
}

export async function suggestClipBroll(words: EditorWord[], edit: ClipEdit): Promise<BrollItem[]> {
  const sentences = sentencesToTranslate(words, edit);
  if (sentences.length === 0) return [];
  const picks = await suggestBroll(sentences, outputDuration(keptRanges(edit, words)));
  const spoken = clipWords(words, edit).filter((w) => !edit.words[w.id]?.hidden);
  const ids = pickWordIds(spoken, picks);
  const used = new Set(edit.broll.map((b) => b.video.id));
  const items: BrollItem[] = [];
  for (let i = 0; i < picks.length; i++) {
    const wordId = ids[i];
    if (!wordId) continue;
    const results = await searchVideos(picks[i].query, orientationFor(edit.aspect));
    const video = results.find((v) => !used.has(v.id));
    if (!video) continue;
    await downloadVideo(video);
    used.add(video.id);
    items.push({ video, wordId, duration: BROLL_DURATION.default, query: picks[i].query });
  }
  return items;
}
