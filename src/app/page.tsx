import Link from 'next/link';
import { UploadForm } from '@/components/UploadForm';
import { RecentJobs } from '@/components/RecentJobs';

export default function HomePage() {
  return (
    <main className="relative flex flex-col items-center px-4 py-16 md:py-24">
      <Link href="/settings" className="absolute top-4 right-4 text-sm text-gray-400 hover:text-white">
        Inställningar
      </Link>
      <div className="text-center mb-12 max-w-2xl">
        <h1 className="text-3xl md:text-5xl font-bold mb-4 tracking-tight">
          Auto <span className="text-accent-400">Clipper</span>
        </h1>
        <p className="text-gray-400 text-base md:text-lg leading-relaxed">
          Ladda upp en lång video eller klistra in en YouTube-länk. AI:n hittar de bästa
          ögonblicken, klipper ut dem, följer talaren i bild och lägger på animerade texter
          automatiskt - redo för TikTok, Reels och Shorts. Finjustera sen varje klipp i
          redigeraren.
        </p>
      </div>
      <UploadForm />
      <RecentJobs />
    </main>
  );
}
