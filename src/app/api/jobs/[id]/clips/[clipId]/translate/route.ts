import { NextRequest, NextResponse } from 'next/server';
import { findEditableClip } from '@/lib/editorRoutes';
import { translateSentences } from '@/lib/gemini';
import { sanitizeEdit } from '@/lib/edit/presets';
import { captionLanguage, sentencesToTranslate } from '@/lib/edit/translation';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string; clipId: string }> };

/**
 * Translate the clip's captions: `{ lang, edit }` with the editor's current
 * edit (its start, end and corrected words decide which sentences). Returns
 * the translation; the editor puts it in the edit, so it can be undone.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { id, clipId } = await params;
  const found = findEditableClip(id, clipId);
  if (found instanceof NextResponse) return found;
  const body = await req.json().catch(() => null);
  const language = captionLanguage(typeof body?.lang === 'string' ? body.lang : null);
  if (!language) return NextResponse.json({ error: 'Okänt språk.' }, { status: 400 });
  const edit = sanitizeEdit(body?.edit ?? {}, {
    window: found.data.window,
    wordIds: new Set(found.data.words.map((w) => w.id)),
    fallback: found.edit,
  });
  const sentences = sentencesToTranslate(found.data.words, edit);
  if (sentences.length === 0) return NextResponse.json({ error: 'Det finns ingen text att översätta i klippet.' }, { status: 400 });
  try {
    const segments = await translateSentences(sentences, language.english);
    if (Object.keys(segments).length === 0) {
      return NextResponse.json({ error: 'AI:n gav ingen översättning. Försök igen.' }, { status: 502 });
    }
    return NextResponse.json({ translation: { lang: language.code, segments } });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
