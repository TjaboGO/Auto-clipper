import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { config } from '@/lib/config';
import { CAPTION_FONTS } from '@/lib/edit/fonts';
import { serveFile } from '@/lib/serveFile';

export const runtime = 'nodejs';

/** The caption fonts, so the editor's preview draws text exactly like the render. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const font = CAPTION_FONTS.find((f) => f.file === file);
  if (!font) {
    return NextResponse.json({ error: 'Typsnittet finns inte.' }, { status: 404 });
  }
  return serveFile(req, path.join(config.fontsDir, font.file), 'font/ttf', 'public, max-age=604800, immutable');
}
