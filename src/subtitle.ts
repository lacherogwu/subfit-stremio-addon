import { unzipSync } from 'fflate';
import iconv from 'iconv-lite';

export interface Cue {
  /** Seconds from the start of the file. */
  start: number;
  end: number;
  text: string;
}

const SUBTITLE_EXT = /\.(srt|sub|vtt|ass|ssa)$/i;
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

/**
 * Hebrew subtitles circulate in CP1255 far more often than in UTF-8, and a wrong guess is
 * not a subtle bug - every line becomes mojibake. UTF-8 is self-validating, so try it
 * first and fall back only when the bytes cannot be UTF-8; that ordering cannot misread a
 * UTF-8 file as CP1255, while the reverse guess would.
 */
export function decodeText(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf8');
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return iconv.decode(buf.subarray(2), 'utf16-le');
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return iconv.decode(buf.subarray(2), 'utf16-be');
  }
  const asUtf8 = buf.toString('utf8');
  // U+FFFD only appears when a byte sequence was not valid UTF-8.
  if (!asUtf8.includes('�')) return asUtf8;
  return iconv.decode(buf, 'win1255');
}

const TIMESTAMP =
  /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;

const toSeconds = (h: string, m: string, s: string, ms: string): number =>
  Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, '0')) / 1000;

/**
 * One parser for SRT and WebVTT: they differ in a header, a millisecond separator and cue
 * settings, none of which change how the timings are read. Anything that is not a timestamp
 * line and not blank is cue text.
 */
export function parseSubtitle(buf: Buffer): Cue[] {
  const text = decodeText(buf);
  const lines = text.split(/\r?\n/);
  const cues: Cue[] = [];

  for (let i = 0; i < lines.length; i++) {
    const m = TIMESTAMP.exec(lines[i] ?? '');
    if (!m) continue;
    const start = toSeconds(m[1] ?? '0', m[2] ?? '0', m[3] ?? '0', m[4] ?? '0');
    const end = toSeconds(m[5] ?? '0', m[6] ?? '0', m[7] ?? '0', m[8] ?? '0');

    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j] ?? '';
      if (line.trim() === '' || TIMESTAMP.test(line)) break;
      body.push(line);
      i = j;
    }
    cues.push({ start, end, text: body.join('\n').trim() });
  }

  return cues;
}

const stamp = (t: number): string => {
  const clamped = Math.max(0, t);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const ms = Math.round((clamped - Math.floor(clamped)) * 1000);
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
};

export function toSrt(cues: Cue[]): string {
  return cues
    .map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`)
    .join('\n');
}

/**
 * Wizdom serves a zip; OpenSubtitles serves the file directly. Sniffing the magic bytes
 * rather than trusting a content type or a URL suffix keeps both paths on one code path.
 */
export function unzipFirstSubtitle(buf: Buffer): Buffer {
  const isZip = ZIP_MAGIC.every((b, i) => buf[i] === b);
  if (!isZip) return buf;

  const entries = unzipSync(new Uint8Array(buf));
  const names = Object.keys(entries);
  const name = names.find((n) => SUBTITLE_EXT.test(n)) ?? names[0];
  if (!name) throw new Error('zip held no files');
  const found = entries[name];
  if (!found) throw new Error(`zip entry ${name} could not be read`);
  return Buffer.from(found);
}
