import { NextRequest, NextResponse } from 'next/server';
import { styleJob } from '@/lib/styleFromVideo';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

/** How making a template from a video is going (and the template once it's done). */
export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const job = /^[0-9a-f-]{36}$/.test(id) ? styleJob(id) : null;
  if (!job) return NextResponse.json({ error: 'Hittar inte det jobbet (servern kan ha startats om).' }, { status: 404 });
  return NextResponse.json({ job });
}
