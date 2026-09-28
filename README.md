# Auto Clipper

En egen AI-version av Opus Clip. Du laddar upp en lång video (eller klistrar in en YouTube-länk),
och appen:

1. Transkriberar hela ljudet med Gemini
2. Låter Gemini agera videoredaktör och plockar ut de bästa, mest klippbara ögonblicken
3. Klipper ut varje ögonblick, beskär det till stående 9:16-format och följer den som pratar i
   bild (ansiktsspårning med OpenCV). Pratar två personer i snabb växling delas bilden istället, med
   en person upptill och en nedtill
4. Bränner in animerade texter i CapCut/TikTok-stil, några ord i taget med ordet som sägs just nu
   i guld. Whisper lyssnar på varje klipp så att orden lyser upp exakt när de sägs, och klippen
   börjar och slutar på riktiga ordgränser
5. Ger dig färdiga klipp att ladda ner, plus förslag på titel, bildtext och hashtags för varje
   klipp
6. Låter dig finjustera varje klipp i en redigerare med förhandsvisning direkt i webbläsaren:
   klipp bort ord i texten, ta bort utfyllnadsord och pauser, dra i start och slut, rätta
   stavning, byt textstil, typsnitt, format och layout, beskär själv och lägg till en rubrik.
   Sen renderar du om klippet med ett klick

Allt körs i en enda container: Next.js-appen, ffmpeg för videoklippning, Python/OpenCV för
ansiktsspårningen och faster-whisper för ordtimingen.

## Komma igång lokalt

Krav: Node 20.9+ (22 rekommenderas), ffmpeg, python3 med paketen i `requirements.txt` (OpenCV och
faster-whisper), och `yt-dlp` om du vill kunna klistra in YouTube-länkar.

```bash
npm install
pip install -r requirements.txt
cp .env.example .env
# lägg in din GEMINI_API_KEY i .env (skaffa en gratis på https://aistudio.google.com/apikey)
npm run dev
```

Öppna http://localhost:3000. Testerna körs med `npm test`.

För YouTube-länkar: installera `pip install "yt-dlp[default]"`. yt-dlp behöver en JavaScript-motor
för YouTube. Har du inte Deno installerat, lägg till raden `--js-runtimes node` i
`~/.config/yt-dlp/config` så används Node istället (kräver Node 22 eller nyare). Docker-imagen har
det redan inställt.

## Köra med Docker (rekommenderas, t.ex. på Coolify)

```bash
cp .env.example .env
# fyll i GEMINI_API_KEY i .env
docker compose up --build
```

Docker-bilden innehåller redan ffmpeg, python3, opencv, faster-whisper, yt-dlp och typsnitten för
texterna, så du behöver inte installera något extra på servern. Den har också en healthcheck som
Coolify kan använda. Whisper-modellen laddas ner första gången ett jobb körs och sparas i
`/app/storage/models`, så den finns kvar mellan deployer.

I Coolify: peka på det här repot, sätt `GEMINI_API_KEY` som miljövariabel, och montera en volym på
`/app/storage` så att renderade klipp överlever omstarter. Källvideorna sparas också där (för
redigeraren) i `SOURCE_RETENTION_DAYS` dagar, så räkna med plats för dem.

**Viktigt:** appen har ingen inloggning. Alla som hittar adressen kan starta jobb på din
Gemini-nyckel och din server. Lägg den bakom något skydd om den ligger publikt, till exempel
Basic Auth i Coolify.

## Hur det funkar under huven

- `src/lib/gemini.ts` - pratar med Gemini via `@google/genai`. Ljudet laddas upp i bitar på max
  10 minuter och transkriberas en bit i taget, så svaren aldrig blir för långa och tidsstämplarna
  håller sig exakta även för långa videor. Sen får Gemini (som redaktör) välja ut de bästa klippen
  med titel, bildtext, hashtags och ett "virality score". Båda anropen använder ett JSON-schema,
  och kvotfel och tillfälliga serverfel försöks om automatiskt.
- `scripts/smart_crop.py` - bestämmer hur varje klipp beskärs. ffmpeg avkodar och skalar ner tio
  bilder per sekund ur klippet, och YuNet (OpenCV:s ansiktsdetektor) hittar ansiktena och var ögon
  och mun sitter. Varje person får ett eget spår genom klippet. När det hörs tal jämförs
  munrörelserna för att se vem som pratar, och kameran klipper till den personen. Ett kort "ja"
  från någon annan räcker inte för ett byte. Rör sig personen panorerar kameran mjukt. Pratar två
  personer i snabb växling blir klippet split screen istället, och texten hamnar i skarven mellan
  dem. Modellen (MIT-licens) ligger i `assets/models`. Saknas den används OpenCV:s äldre
  Haar-detektor, som bara följer det största ansiktet.
- `scripts/word_timing.py` + `src/lib/wordTiming.ts` - när Gemini valt klippen lyssnar Whisper
  (faster-whisper) på vart och ett och säger när varje ord sägs. Orden matchas mot Geminis text
  (felhörda, missade och extra ord hanteras, liksom sammansatta ord som delats olika), och
  klippets start och slut flyttas till riktiga ordgränser så inget klipp börjar eller slutar mitt i
  ett ord. Om Whisper inte kan köras, eller matchningen blir för osäker, används den uppskattade
  timingen istället, så jobbet går alltid igenom.
- `src/lib/captions.ts` - bygger en `.ass`-undertextfil per klipp i vald stil: Karaoke (ordet som
  sägs lyser), Box (färgad ruta bakom ordet), Pop (ordet växer), Ord för ord och Enkel, plus
  rubriken överst. Nio fria typsnitt (SIL OFL och Apache 2.0, licenserna ligger i
  `assets/fonts/licenses`) så texterna ser likadana ut på alla maskiner.
- `src/lib/render.ts` + `src/lib/renderGraph.ts` - renderar ett klipp i ett enda ffmpeg-kommando:
  beskärning (följ talaren, split screen, eller hela bilden med suddig bakgrund) i valt format
  (9:16, 1:1, 4:5, 16:9), bortklippta ord och pauser (bilden väljs ut och flyttas ihop, ljudet
  klipps med korta toningar så skarvarna inte klickar) och texterna. Pipelinen och redigeraren
  renderar på samma sätt, så ett oredigerat klipp blir likadant om det renderas om.
- `src/lib/edit/` - redigerarens logik, delad mellan webbläsaren och servern: tidslinjen (vilka
  delar som klipps bort, hur tiden räknas om), textsidorna, bildformat och beskärning. Därför
  visar förhandsvisningen samma sak som den färdiga videon.
- `src/lib/editor.ts` - sparar varje klipps ord, ansiktsanalys och redigering, gör en liten
  förhandsvideo och ljudvåg när redigeraren öppnas första gången, och renderar om klipp i kön
  (med ny ansiktsanalys och exakt ordtiming om klippet förlängts). Sköter också städningen av
  gamla källvideor.
- `src/components/editor/` - redigeraren: förhandsvisning i en canvas, transkriptet, tidslinjen
  och inställningarna. Ångra och gör om, autospar och kortkommandon (mellanslag spelar, Delete
  klipper bort markerade ord, Ctrl+Z ångrar, pilarna spolar).
- `src/lib/pipeline.ts` - kopplar ihop alla steg ovan och uppdaterar jobbets status så frontend kan
  visa live-progress. Om ett klipp misslyckas fortsätter resten.
- `src/lib/youtube.ts` - hämtar videon med `yt-dlp` om du klistrar in en länk istället för att
  ladda upp en fil.
- Jobb körs i en enkel kö i minnet (`src/lib/queue.ts`) och sparas till `storage/jobs.json`, så
  historiken överlever en omstart. Jobb som var igång när servern startades om markeras som
  avbrutna. Inget behov av en separat databas för ett projekt som det här.

### API

- `POST /api/jobs?filename=video.mp4&clipCount=6` med själva videofilen som request-body. Filen
  strömmas direkt till disk, så även stora filer (max 2 GB) klarar sig utan mycket minne.
- `POST /api/jobs` med JSON `{ "youtubeUrl": "https://...", "clipCount": 6 }` för en länk.
- `GET /api/jobs/<id>` för status och klipp, `GET /api/jobs` för de senaste jobben,
  `DELETE /api/jobs/<id>` tar bort ett jobb med alla filer.
- Redigeraren: `GET /api/jobs/<id>/clips/<clipId>/editor` (ord, analys, redigering, förhandsvideo),
  `PUT .../edit` sparar en redigering, `POST .../render` renderar om klippet.

## Kända begränsningar (värt att veta)

- **Ordtimingen kostar lite tid och minne.** Whisper körs på serverns CPU, bara på de valda
  klippen (inte hela videon). Med `small` tar det ungefär en halv till ett par minuter per jobb
  beroende på servern, och behöver runt 1 GB RAM medan det körs. På en liten server: sätt
  `WHISPER_MODEL=base`, eller `WORD_TIMING=off` för att stänga av det.
- **Vem som pratar är en gissning.** Appen tittar på munrörelser medan det hörs tal, så den kan ta
  fel, till exempel om den som pratar syns från sidan eller om någon annan skrattar eller tuggar.
  Split screen bestäms för hela klippet och kan inte slås av och på mitt i det.
- **Källvideon sparas en tid för redigeraren.** Den tas bort automatiskt efter
  `SOURCE_RETENTION_DAYS` dagar (7 som standard) utan ändringar, eller när du tar bort jobbet.
  Efter det finns klippen kvar men kan inte redigeras. Sätt 0 för att radera direkt efter jobbet.
- **Förhandsvisningen är en lättare kopia.** Den visar exakt vad som renderas men i lägre
  upplösning, och där ordtiderna är uppskattade kan klipp mitt i meningar se lite ojämna ut tills
  klippet renderats (då tas exakta tider fram).
- **Redigeraren har inte allt som Opus har.** Det finns ingen B-roll, musik, emojis, logotyp,
  övergångar eller publicering direkt till TikTok och YouTube. Split screen-halvorna följer
  personerna automatiskt och kan bara byta plats, inte beskäras för hand.
- **En kö-arbetare i taget som standard** (`QUEUE_CONCURRENCY=1`). Höj den om servern har gott om
  CPU, men ffmpeg + ansiktsdetektering är tungt - testa dig fram.
- **Ingen inloggning eller multi-user-stöd.** Det här är byggt som ett personligt verktyg, inte en
  SaaS. Se varningen under Docker-avsnittet.
- **Lagring är lokala filer**, inte S3 eller liknande. Funkar fint på en enda server, men skalar
  inte till flera instanser utan ändringar.

## Miljövariabler

Se `.env.example`. Den viktiga är `GEMINI_API_KEY`. `GEMINI_MODEL` är `gemini-3.5-flash` som
standard. Google pensionerar gamla modeller med jämna mellanrum, så byt till en aktuell om jobben
börjar faila med att modellen inte hittas. `WORD_TIMING` och `WHISPER_MODEL` styr ordtimingen, och
`SOURCE_RETENTION_DAYS` hur länge källvideon sparas för redigeraren.

## Tech stack

Next.js 16 (App Router, TypeScript) + React 19 + Tailwind, `@google/genai` för Gemini,
ffmpeg/ffprobe för videobehandling, Python + OpenCV för ansiktsspårning, faster-whisper för
ordtiming, `yt-dlp` för YouTube-nedladdning.

## Plan framåt

1. ~~Exakt ordtiming och rena klippkanter~~ (klar)
2. ~~Bättre ansiktsföljning: bättre ansiktsdetektor, följa den som pratar, split screen när två
   pratar~~ (klar)
3. ~~Redigerare: klipp bort ord, utfyllnadsord och pauser, flytta start och slut, rätta ord,
   textstilar, format, layout, manuell beskärning, rubrik, rendera om~~ (klar)
4. Fler val redan när jobbet startas: klipplängd, format och textstil, en sökruta ("hitta
   ögonblick om X"), och att AI:n markerar nyckelord i texten
5. Låta Gemini titta på videon, så det funkar även för innehåll utan prat
