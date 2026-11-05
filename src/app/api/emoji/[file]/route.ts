import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { config } from '@/lib/config';
import { emojiFile, EMOJIS } from '@/lib/edit/emoji';
import { serveFile } from '@/lib/serveFile';

export const runtime = 'nodejs';

const FILES = new Set(EMOJIS.map(emojiFile));

/** The emoji images, so the editor's preview shows the same pictures as the render. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  if (!FILES.has(file)) return NextResponse.json({ error: 'Den emojin finns inte.' }, { status: 404 });
  return serveFile(req, path.join(config.emojiDir, file), 'image/png', 'public, max-age=604800, immutable');
}
