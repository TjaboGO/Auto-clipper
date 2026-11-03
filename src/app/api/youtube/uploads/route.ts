import { NextResponse } from 'next/server';
import { jobStore } from '@/lib/jobStore';

export const runtime = 'nodejs';

/** Every clip that has been sent to YouTube (or is on its way), for the calendar. */
export async function GET() {
  const uploads = jobStore.list().flatMap((job) =>
    (job.clips ?? []).flatMap((clip) =>
      [clip.youtube, ...(clip.youtubeHistory ?? [])]
        .filter((upload) => !!upload)
        .map((upload) => ({
          jobId: job.id,
          clipId: clip.id,
          clipTitle: clip.title,
          thumb: `/api/clips/${job.id}/${clip.filename.replace(/\.mp4$/, '.jpg')}`,
          durationSec: clip.durationSec,
          upload,
        })),
    ),
  );
  return NextResponse.json({ uploads });
}
