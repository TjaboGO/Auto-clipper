import type { NextRequest } from 'next/server';

export class BodyTooLargeError extends Error {}

/** The raw request body, refusing anything bigger than `max` bytes. */
export async function readLimitedBody(req: NextRequest, max: number): Promise<Buffer> {
  const declared = Number(req.headers.get('content-length') || 0);
  if (declared > max) throw new BodyTooLargeError();
  const body = Buffer.from(await req.arrayBuffer());
  if (body.length > max) throw new BodyTooLargeError();
  return body;
}
