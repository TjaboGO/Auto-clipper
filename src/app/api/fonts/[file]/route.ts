import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { config } from '@/lib/config';
import { customFontPath } from '@/lib/brand';
import { CAPTION_FONTS } from '@/lib/edit/fonts';
import { serveFile } from '@/lib/serveFile';

export const runtime = 'nodejs';

/** The caption fonts (yours too), so the editor's preview draws text exactly like the render. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const builtIn = CAPTION_FONTS.find((f) => f.file === file);
  const filePath = builtIn ? path.join(config.fontsDir, builtIn.file) : customFontPath(file);
  if (!filePath) {
    return NextResponse.json({ error: 'Typsnittet finns inte.' }, { status: 404 });
  }
  const type = file.endsWith('.otf') ? 'font/otf' : 'font/ttf';
  // A custom font's file name is its content hash, so it never changes either.
  return serveFile(req, filePath, type, 'public, max-age=604800, immutable');
}
