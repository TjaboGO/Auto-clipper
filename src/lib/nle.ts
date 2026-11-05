// A clip as a timeline for Premiere Pro and DaVinci Resolve: the classic
// Final Cut Pro 7 XML ("xmeml"), which both import. Every media file is
// made at the sequence's size and frame rate (the video already framed,
// the graphics on a see-through layer, the stock video cropped to fill),
// so the timeline needs no moving or scaling, only cuts. Plain functions,
// no Node imports, so they're easy to test.
import type { TimeRange } from './edit/types';

/** A frame rate as xmeml writes it: a whole number, and whether it's the NTSC variant (x 1000/1001). */
export interface NleRate {
  timebase: number;
  ntsc: boolean;
}

const RATES: NleRate[] = [
  { timebase: 24, ntsc: true },
  { timebase: 24, ntsc: false },
  { timebase: 25, ntsc: false },
  { timebase: 30, ntsc: true },
  { timebase: 30, ntsc: false },
  { timebase: 50, ntsc: false },
  { timebase: 60, ntsc: true },
  { timebase: 60, ntsc: false },
];

export function rateFps(rate: NleRate): number {
  return rate.ntsc ? (rate.timebase * 1000) / 1001 : rate.timebase;
}

/** The standard frame rate closest to a video's (29.97 for 29.97, 25 for 25, 30 for an odd 31 ...). */
export function nleRate(fps: number): NleRate {
  const target = Number.isFinite(fps) && fps > 0 ? fps : 30;
  return RATES.reduce((best, r) => (Math.abs(rateFps(r) - target) < Math.abs(rateFps(best) - target) ? r : best));
}

/** The rate for ffmpeg's -r: "30000/1001" or "25". */
export function ffmpegRate(rate: NleRate): string {
  return rate.ntsc ? `${rate.timebase * 1000}/1001` : String(rate.timebase);
}

/** Seconds as a whole number of frames. */
export function toFrames(seconds: number, rate: NleRate): number {
  return Math.round(seconds * rateFps(rate));
}

/** One kept part of the clip on the timeline, in frames. */
export interface TimelineCut {
  /** Where it starts and ends in the media file. */
  in: number;
  out: number;
  /** Where it sits on the timeline. */
  start: number;
  end: number;
}

/**
 * The kept parts of the clip (source seconds) as cuts on a timeline that
 * starts at 0, from a media file whose first frame is source time
 * `mediaStart`. Each edge on the timeline is rounded from its exact time,
 * so the cuts never drift away from the captions over a long clip.
 */
export function timelineCuts(kept: TimeRange[], mediaStart: number, rate: NleRate): TimelineCut[] {
  const cuts: TimelineCut[] = [];
  let at = 0;
  for (const r of kept) {
    const start = toFrames(at, rate);
    at += r.end - r.start;
    const end = toFrames(at, rate);
    if (end <= start) continue;
    const inFrame = Math.max(0, toFrames(r.start - mediaStart, rate));
    cuts.push({ in: inFrame, out: inFrame + (end - start), start, end });
  }
  return cuts;
}

/** A media file in the project folder. Times in seconds. */
export interface NleMedia {
  /** File name next to the XML (plain ASCII, so it relinks on any system). */
  file: string;
  duration: number;
}

export interface NleProject {
  name: string;
  rate: NleRate;
  width: number;
  height: number;
  /** The framed video (and its sound), starting at source time `start`. */
  video: NleMedia & { start: number; hasAudio: boolean };
  /** The kept parts of the clip, source seconds. */
  kept: TimeRange[];
  /** Captions, title, logo and emojis on a see-through layer, from the start of the clip. */
  graphics?: NleMedia | null;
  /** Stock video over the clip: when (seconds of the finished clip). */
  broll?: (NleMedia & { start: number })[];
  /** Background music from the start of the clip. */
  music?: NleMedia | null;
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function rateXml(rate: NleRate): string {
  return `<rate><timebase>${rate.timebase}</timebase><ntsc>${rate.ntsc ? 'TRUE' : 'FALSE'}</ntsc></rate>`;
}

function timecodeXml(rate: NleRate): string {
  return (
    `<timecode>${rateXml(rate)}<string>00:00:00:00</string><frame>0</frame>` +
    `<displayformat>NDF</displayformat></timecode>`
  );
}

function videoCharacteristics(p: NleProject): string {
  return (
    `<samplecharacteristics>${rateXml(p.rate)}<width>${p.width}</width><height>${p.height}</height>` +
    `<anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio>` +
    `<fielddominance>none</fielddominance></samplecharacteristics>`
  );
}

const AUDIO_CHARACTERISTICS = '<samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics>';

/** A file's full description the first time it's used, a reference after that. */
class Files {
  private seen = new Set<string>();
  private ids = new Map<string, string>();

  constructor(private project: NleProject) {}

  xml(media: NleMedia, kinds: { video: boolean; audio: boolean }): string {
    let id = this.ids.get(media.file);
    if (!id) {
      id = `file-${this.ids.size + 1}`;
      this.ids.set(media.file, id);
    }
    if (this.seen.has(id)) return `<file id="${id}"/>`;
    this.seen.add(id);
    const p = this.project;
    return (
      `<file id="${id}"><name>${esc(media.file)}</name>` +
      `<pathurl>${esc(encodeURIComponent(media.file))}</pathurl>` +
      `${rateXml(p.rate)}<duration>${toFrames(media.duration, p.rate)}</duration>${timecodeXml(p.rate)}<media>` +
      (kinds.video ? `<video>${videoCharacteristics(p)}</video>` : '') +
      (kinds.audio ? `<audio>${AUDIO_CHARACTERISTICS}<channelcount>2</channelcount></audio>` : '') +
      `</media></file>`
    );
  }
}

interface Item {
  id: string;
  media: NleMedia;
  cut: TimelineCut;
  kind: 'video' | 'audio';
  /** Audio: which channel of the file (1 or 2). */
  channel?: number;
  alpha?: boolean;
  /** Ids of the items it moves with (the video and its two sound channels). */
  links?: { id: string; kind: 'video' | 'audio'; track: number; index: number }[];
}

function itemXml(item: Item, files: Files, kinds: { video: boolean; audio: boolean }, rate: NleRate): string {
  const { cut } = item;
  const links = (item.links ?? [])
    .map(
      (l) =>
        `<link><linkclipref>${l.id}</linkclipref><mediatype>${l.kind}</mediatype>` +
        `<trackindex>${l.track}</trackindex><clipindex>${l.index}</clipindex>` +
        (l.kind === 'audio' ? '<groupindex>1</groupindex>' : '') +
        `</link>`,
    )
    .join('');
  return (
    `<clipitem id="${item.id}"><name>${esc(item.media.file)}</name><enabled>TRUE</enabled>` +
    `<duration>${toFrames(item.media.duration, rate)}</duration>${rateXml(rate)}` +
    `<start>${cut.start}</start><end>${cut.end}</end><in>${cut.in}</in><out>${cut.out}</out>` +
    (item.alpha ? '<alphatype>straight</alphatype>' : '') +
    files.xml(item.media, kinds) +
    (item.kind === 'audio'
      ? `<sourcetrack><mediatype>audio</mediatype><trackindex>${item.channel ?? 1}</trackindex></sourcetrack>`
      : '') +
    links +
    `</clipitem>`
  );
}

/** A whole file from the start of the timeline (or `at` seconds into it), cut to the clip's length. */
function wholeCut(media: NleMedia, at: number, length: number, rate: NleRate): TimelineCut | null {
  const start = toFrames(at, rate);
  const end = Math.min(toFrames(length, rate), start + toFrames(media.duration, rate));
  return end > start ? { in: 0, out: end - start, start, end } : null;
}

/** The project as Final Cut Pro 7 XML, for Premiere Pro (File > Import) and DaVinci Resolve (File > Import > Timeline). */
export function buildXmeml(p: NleProject): string {
  const files = new Files(p);
  const rate = p.rate;
  const cuts = timelineCuts(p.kept, p.video.start, rate);
  const length = cuts.length ? cuts[cuts.length - 1].end : 0;
  const lengthSec = length / rateFps(rate);
  const sound = p.video.hasAudio;
  const both = { video: true, audio: sound };

  // V1: the framed video, cut. A1 and A2: its sound (left and right).
  const v1 = cuts.map((cut, i) => {
    const links: Item['links'] = sound
      ? [
          { id: `video-${i + 1}`, kind: 'video', track: 1, index: i + 1 },
          { id: `sound-l-${i + 1}`, kind: 'audio', track: 1, index: i + 1 },
          { id: `sound-r-${i + 1}`, kind: 'audio', track: 2, index: i + 1 },
        ]
      : undefined;
    return itemXml({ id: `video-${i + 1}`, media: p.video, cut, kind: 'video', links }, files, both, rate);
  });
  const audioTracks: string[][] = [];
  if (sound) {
    for (const channel of [1, 2]) {
      audioTracks.push(
        cuts.map((cut, i) =>
          itemXml(
            {
              id: `sound-${channel === 1 ? 'l' : 'r'}-${i + 1}`,
              media: p.video,
              cut,
              kind: 'audio',
              channel,
              links: [
                { id: `video-${i + 1}`, kind: 'video', track: 1, index: i + 1 },
                { id: `sound-l-${i + 1}`, kind: 'audio', track: 1, index: i + 1 },
                { id: `sound-r-${i + 1}`, kind: 'audio', track: 2, index: i + 1 },
              ],
            },
            files,
            both,
            rate,
          ),
        ),
      );
    }
  }

  // V2: stock video. V3: the graphics, over everything.
  const videoTracks = [v1];
  const broll = (p.broll ?? []).flatMap((b, i) => {
    const cut = wholeCut(b, b.start, lengthSec, rate);
    return cut ? [itemXml({ id: `broll-${i + 1}`, media: b, cut, kind: 'video' }, files, { video: true, audio: false }, rate)] : [];
  });
  if (broll.length) videoTracks.push(broll);
  const graphicsCut = p.graphics ? wholeCut(p.graphics, 0, lengthSec, rate) : null;
  if (p.graphics && graphicsCut) {
    videoTracks.push([
      itemXml({ id: 'graphics-1', media: p.graphics, cut: graphicsCut, kind: 'video', alpha: true }, files, { video: true, audio: false }, rate),
    ]);
  }

  // A3 and A4: the music.
  const musicCut = p.music ? wholeCut(p.music, 0, lengthSec, rate) : null;
  if (p.music && musicCut) {
    for (const channel of [1, 2]) {
      audioTracks.push([
        itemXml(
          { id: `music-${channel}`, media: p.music, cut: musicCut, kind: 'audio', channel },
          files,
          { video: false, audio: true },
          rate,
        ),
      ]);
    }
  }

  const track = (items: string[]) => `<track><enabled>TRUE</enabled><locked>FALSE</locked>${items.join('')}</track>`;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="4">` +
    `<sequence id="sequence-1"><name>${esc(p.name)}</name><duration>${length}</duration>${rateXml(rate)}` +
    `${timecodeXml(rate)}<media>` +
    `<video><format>${videoCharacteristics(p)}</format>${videoTracks.map(track).join('')}</video>` +
    `<audio><numOutputChannels>2</numOutputChannels><format>${AUDIO_CHARACTERISTICS}</format>` +
    `${audioTracks.map(track).join('')}</audio>` +
    `</media></sequence></xmeml>\n`
  );
}
