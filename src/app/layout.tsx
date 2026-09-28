import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Auto Clipper',
  description:
    'AI som hittar dina bästa klipp automatiskt, beskär i vertikalt format och lägger på texter - som Opus Clip, fast ditt eget.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="sv">
      <body className="bg-base-950 text-white min-h-screen antialiased">{children}</body>
    </html>
  );
}
