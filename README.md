# Auto Clipper

En egen AI-version av Opus Clip. Du laddar upp en lång video (eller klistrar in en YouTube-länk),
och appen:

1. Transkriberar hela ljudet med Gemini
2. Låter Gemini agera videoredaktör och plockar ut de bästa, mest klippbara ögonblicken
3. Klipper ut varje ögonblick, beskär det till stående 9:16-format och följer den som pratar i
   bild (ansiktsspårning med OpenCV)
4. Bränner in animerade, ord-för-ord-texter i CapCut/TikTok-stil
5. Ger dig färdiga klipp att ladda ner, plus förslag på titel, bildtext och hashtags för varje
   klipp

Allt körs i en enda container: Next.js-appen, ffmpeg för videoklippning, och Python/OpenCV för
ansiktsspårningen.

## Komma igång lokalt

Krav: Node 20+, ffmpeg, python3 med `opencv-python` installerat, och `yt-dlp` om du vill kunna
klistra in YouTube-länkar.

```bash
npm install
cp .env.example .env
# lägg in din GEMINI_API_KEY i .env (skaffa en gratis på https://aistudio.google.com/apikey)
npm run dev
```

Öppna http://localhost:3000.

## Köra med Docker (rekommenderas, t.ex. på Coolify)

```bash
cp .env.example .env
# fyll i GEMINI_API_KEY i .env
docker compose up --build
```

Docker-bilden innehåller redan ffmpeg, python3, opencv och yt-dlp, så du behöver inte installera
något extra på servern.

I Coolify: peka på det här repot, sätt `GEMINI_API_KEY` som miljövariabel, och montera en volym på
`/app/storage` så att renderade klipp överlever omstarter.

## Hur det funkar under huven

- `src/lib/gemini.ts` - laddar upp ljudet till Gemini, ber om en tidsstämplad transkribering, och
  ber sedan Gemini (som redaktör) välja ut de bästa klippen med titel, bildtext, hashtags och ett
  "virality score".
- `scripts/smart_crop.py` - kör ansiktsdetektering (OpenCV Haar cascade) över varje klipp och
  räknar ut var den stående kameran ska "titta" över tid, med utjämning så det inte hackar.
- `src/lib/captions.ts` - bygger en `.ass`-undertextfil per klipp med karaoke-taggar, så orden
  lyser upp i takt med talet.
- `src/lib/ffmpeg.ts` - klipper ut, beskär (dynamiskt om källan är liggande, annars skalas den om
  till stående format med svarta kanter) och bränner in texterna - allt i ett enda ffmpeg-kommando
  per klipp.
- `src/lib/pipeline.ts` - kopplar ihop alla steg ovan och uppdaterar jobbets status så frontend kan
  visa live-progress.
- `src/lib/youtube.ts` - hämtar videon med `yt-dlp` om du klistrar in en länk istället för att
  ladda upp en fil.
- Jobb körs i en enkel kö i minnet (`src/lib/queue.ts`) och sparas till `storage/jobs.json`, så
  historiken överlever en omstart. Inget behov av en separat databas för ett projekt som det här.

## Kända begränsningar (värt att veta)

- **Textningens ordtiming är en uppskattning.** Gemini ger tidsstämplar per mening/fras, inte per
  ord. Varje ords "lystid" i undertexten delas jämnt ut över meningens längd, vilket ser bra ut
  men inte är perfekt forcerad ljudsynk. Vill du ha exakt ord-för-ord-timing kan du byta ut
  `transcribeAudio` i `src/lib/gemini.ts` mot t.ex. Whisper med ordnivå-tidsstämplar.
- **En kö-arbetare i taget som standard** (`QUEUE_CONCURRENCY=1`). Höj den om servern har gott om
  CPU, men ffmpeg + ansiktsdetektering är tungt - testa dig fram.
- **Ingen inloggning eller multi-user-stöd.** Det här är byggt som ett personligt verktyg, inte en
  SaaS. Lägg till auth själv om du vill dela det med fler.
- **Lagring är lokala filer**, inte S3 eller liknande. Funkar fint på en enda server, men skalar
  inte till flera instanser utan ändringar.

## Miljövariabler

Se `.env.example`. Den viktiga är `GEMINI_API_KEY`.

## Tech stack

Next.js 14 (App Router, TypeScript) + Tailwind, `@google/generative-ai` för Gemini, ffmpeg/ffprobe
för videobehandling, Python + OpenCV för ansiktsspårning, `yt-dlp` för YouTube-nedladdning.
