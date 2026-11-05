import { NextRequest, NextResponse } from 'next/server';
import { findEditableClip } from '@/lib/editorRoutes';
import { emojiWordIds } from '@/lib/editorWords';
import { suggestEmojis } from '@/lib/gemini';
import { sanitizeEdit } from '@/lib/edit/presets';
import { clipWords, keptRanges, outputDuration } from '@/lib/edit/timeline';
import { sentencesToTranslate } from '@/lib/edit/translation';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string; clipId: string }> };

/**
 * Let the AI put emojis on the clip's words: `{ edit }` with the editor's
 * current edit in, `{ emojis: { wordId: emoji } }` out (the editor puts
 * them in the edit, so they can be undone).
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { id, clipId } = await params;
  const found = findEditableClip(id, clipId);
  if (found instanceof NextResponse) return found;
  const body = await req.json().catch(() => null);
  const edit = sanitizeEdit(body?.edit ?? {}, {
    window: found.data.window,
    wordIds: new Set(found.data.words.map((w) => w.id)),
    fallback: found.edit,
  });
  const sentences = sentencesToTranslate(found.data.words, edit);
  if (sentences.length === 0) return NextResponse.json({ error: 'Ingen pratar i klippet.' }, { status: 400 });
  try {
    const picks = await suggestEmojis(sentences, outputDuration(keptRanges(edit, found.data.words)));
    const spoken = clipWords(found.data.words, edit).filter((w) => !edit.words[w.id]?.hidden);
    const emojis = emojiWordIds(spoken, picks);
    if (Object.keys(emojis).length === 0) {
      return NextResponse.json({ error: 'AI:n hittade inga ord som passar en emoji.' }, { status: 502 });
    }
    return NextResponse.json({ emojis });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
