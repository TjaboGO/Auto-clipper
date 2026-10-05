import { NextResponse } from 'next/server';
import { brandInfo } from '@/lib/brand';

export const runtime = 'nodejs';

/** Your brand kit: uploaded fonts, logo and "Min stil". */
export async function GET() {
  return NextResponse.json({ brand: brandInfo() });
}
