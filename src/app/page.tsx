import { UploadForm } from '@/components/UploadForm';

export default function HomePage() {
  return (
    <main className="flex flex-col items-center px-4 py-16 md:py-24">
      <div className="text-center mb-12 max-w-2xl">
        <h1 className="text-3xl md:text-5xl font-bold mb-4 tracking-tight">
          Auto <span className="text-accent-400">Clipper</span>
        </h1>
        <p className="text-gray-400 text-base md:text-lg leading-relaxed">
          Ladda upp en lång video eller klistra in en YouTube-länk. AI:n hittar de bästa
          ögonblicken, klipper ut dem, följer talaren i bild och lägger på animerade texter
          automatiskt - redo för TikTok, Reels och Shorts.
        </p>
      </div>
      <UploadForm />
    </main>
  );
}
