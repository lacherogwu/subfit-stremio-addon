import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { Cache } from '../src/cache';
import type { Config } from '../src/config';
import { createApp, parseExtras } from '../src/routes';
import type { RawSub } from '../src/sources';
import cues from './fixtures/cues.json' with { type: 'json' };

const TOKEN = 'testtoken';
const WEB_FILE =
  'Prison.Break.S01E06.Riots.Drills.and.the.Devil.Part.1.1080p.DSNP.WEB-DL.DDP5.1.H.264-playWEB.mkv';
const BLURAY_FILE = 'Prison.Break.S01E06.1080p.BluRay.x264-MIXED.mkv';

const cfg: Config = {
  port: 0,
  baseUrl: '',
  token: TOKEN,
  logFile: '',
  sources: { wizdom: 'http://w', ktuvit: 'http://k', opensubtitles: 'http://o' },
  languages: ['en', 'he', 'ru'],
  deadlineMs: 5000,
  configIssues: [],
};

const srtFor = (starts: number[]): Buffer => {
  const stamp = (t: number): string => {
    const h = String(Math.floor(t / 3600)).padStart(2, '0');
    const m = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
    const s = String(Math.floor(t % 60)).padStart(2, '0');
    const ms = String(Math.round((t - Math.floor(t)) * 1000)).padStart(3, '0');
    return `${h}:${m}:${s},${ms}`;
  };
  return Buffer.from(
    starts.map((t, i) => `${i + 1}\n${stamp(t)} --> ${stamp(t + 2)}\nline ${i}\n`).join('\n'),
    'utf8',
  );
};

const CATALOGUE: [string, number[]][] = [
  ['Prison.Break.S01E06.720p.BluRay.x264-HALCYON', cues.HALCYON],
  ['Prison.Break.S01E06.720p.BluRay.DTS.x264-ESiR', cues.ESiR],
  ['Prison.Break.S01E6.DVDRIP.SAINTS', cues['DVDRIP.SAINTS']],
  ['Prison.Break.S01E6.hdtv-LOL', cues['hdtv-LOL']],
];

const appFor = (opts: { errors?: string[] } = {}) => {
  const subs: RawSub[] = CATALOGUE.map(([name], i) => ({
    id: `wizdom:${i}`,
    source: 'wizdom',
    lang: 'he',
    name,
    url: `http://w/${i}.srt`,
  }));
  return createApp({
    cfg,
    cache: new Cache(mkdtempSync(join(tmpdir(), 'subfit-routes-'))),
    log: () => {},
    fetchAll: async () => ({ subs, errors: opts.errors ?? [] }),
    fetchBody: async (url: string) => {
      const i = Number(/\/(\d+)\.srt$/.exec(url)?.[1] ?? -1);
      const entry = CATALOGUE[i];
      if (!entry) throw new Error('no such fixture');
      return srtFor(entry[1]);
    },
  });
};

const listFor = async (file: string, app = appFor()) => {
  const extras = `filename=${encodeURIComponent(file)}`;
  const res = await app.request(`/${TOKEN}/subtitles/series/tt0455275:1:6/${extras}.json`);
  return {
    res,
    body: (await res.json()) as { subtitles: { id: string; url: string; lang: string }[] },
  };
};

test('parseExtras reads the three keys the matching depends on', () => {
  const extras = parseExtras('videoHash=da82257326ccae25&videoSize=2679739036&filename=A.mkv');
  expect(extras.videoHash).toBe('da82257326ccae25');
  expect(extras.videoSize).toBe('2679739036');
  expect(extras.filename).toBe('A.mkv');
});

test('the manifest answers with the current version', async () => {
  const res = await appFor().request(`/${TOKEN}/manifest.json`);
  expect(res.status).toBe(200);
  expect(((await res.json()) as { version: string }).version).toMatch(/^\d+\.\d+\.\d+$/);
});

test('a wrong token is refused', async () => {
  expect((await appFor().request('/nope/manifest.json')).status).toBe(403);
});

test('a BluRay file gets a star and points every url back at us', async () => {
  const { res, body } = await listFor(BLURAY_FILE);
  expect(res.status).toBe(200);
  expect(body.subtitles[0]?.id).toContain('⭐');
  expect(body.subtitles.every((s) => s.url.includes(`/${TOKEN}/sub/`))).toBe(true);
});

test('the Prison Break WEB-DL case: everything is labelled a mismatch, and nothing is starred', async () => {
  const { body } = await listFor(WEB_FILE);
  expect(body.subtitles.some((s) => s.id.includes('⭐'))).toBe(false);
  expect(body.subtitles.every((s) => s.id.includes('⚠️'))).toBe(true);
  expect(body.subtitles.some((s) => s.id.includes('file is WEB'))).toBe(true);
});

test('the DVD subtitle is offered as re-timed when a BluRay is playing', async () => {
  const { body } = await listFor(BLURAY_FILE);
  expect(body.subtitles.some((s) => s.id.includes('DVD→BluRay'))).toBe(true);
});

test('a dead upstream is surfaced as a visible entry, never an empty list', async () => {
  const { body } = await listFor(BLURAY_FILE, appFor({ errors: ['wizdom: HTTP 500'] }));
  expect(body.subtitles.some((s) => s.id.includes('❌') && s.id.includes('wizdom'))).toBe(true);
});

test('fetching a matched subtitle returns UTF-8 SRT with its timings untouched', async () => {
  const app = appFor();
  const { body } = await listFor(BLURAY_FILE, app);
  const halcyon = body.subtitles.find((s) => s.id.includes('HALCYON'));
  const res = await app.request(new URL(halcyon?.url ?? '').pathname);

  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('utf-8');
  const text = await res.text();
  expect(text).toContain('-->');
  // The first HALCYON cue starts at 1.116 s and must not have moved.
  expect(text).toContain('00:00:01,116');
});

test('fetching a re-timed subtitle returns shifted timings', async () => {
  const app = appFor();
  const { body } = await listFor(BLURAY_FILE, app);
  const dvd = body.subtitles.find((s) => s.id.includes('DVD→BluRay'));
  const text = await (await app.request(new URL(dvd?.url ?? '').pathname)).text();

  const first = /(\d\d):(\d\d):(\d\d),(\d\d\d)/.exec(text);
  const seconds =
    Number(first?.[1]) * 3600 +
    Number(first?.[2]) * 60 +
    Number(first?.[3]) +
    Number(first?.[4]) / 1000;
  const originalFirst = cues['DVDRIP.SAINTS'][0] as number;
  expect(seconds).not.toBeCloseTo(originalFirst, 2);
  expect(seconds).toBeCloseTo(originalFirst * (25 / 23.976), 0);
});

test('an unknown subtitle key is a clean 404', async () => {
  expect((await appFor().request(`/${TOKEN}/sub/deadbeef.srt`)).status).toBe(404);
});

test('the families endpoint reports what exists per language', async () => {
  const res = await appFor().request(`/${TOKEN}/families/series/tt0455275:1:6`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ he: { BluRay: 2, DVD: 1, HDTV: 1 } });
});

test('a subtitle request with no extras still answers', async () => {
  const res = await appFor().request(`/${TOKEN}/subtitles/series/tt0455275:1:6.json`);
  expect(res.status).toBe(200);
  expect(((await res.json()) as { subtitles: unknown[] }).subtitles.length).toBeGreaterThan(0);
});

test("subtitle urls use the configured public address, not the caller's", async () => {
  // An aggregator on the same machine calls us on localhost, but the player that fetches
  // the subtitle may be a television. URLs built from the incoming request would point at
  // 127.0.0.1 and fetch nothing.
  const app = createApp({
    cfg: { ...cfg, baseUrl: 'https://subs.example.com' },
    cache: new Cache(mkdtempSync(join(tmpdir(), 'subfit-base-'))),
    log: () => {},
    fetchAll: async () => ({
      subs: [
        {
          id: 'wizdom:0',
          source: 'wizdom' as const,
          lang: 'he',
          name: CATALOGUE[0]?.[0] ?? '',
          url: 'http://w/0.srt',
        },
      ],
      errors: [],
    }),
    fetchBody: async () => srtFor(CATALOGUE[0]?.[1] ?? []),
  });

  const res = await app.request(`/${TOKEN}/subtitles/series/tt0455275:1:6.json`);
  const body = (await res.json()) as { subtitles: { url: string }[] };
  expect(body.subtitles.every((s) => s.url.startsWith('https://subs.example.com/'))).toBe(true);
});

test('fetching the same subtitle twice serves the cached copy identically', async () => {
  // The second fetch takes a different branch — it serves the stored re-timed body rather
  // than rebuilding it. That branch reached production untested and returned 500.
  const app = appFor();
  const { body } = await listFor(BLURAY_FILE, app);
  const path = new URL(body.subtitles[1]?.url ?? '').pathname;

  const first = await app.request(path);
  expect(first.status).toBe(200);
  const firstText = await first.text();

  const second = await app.request(path);
  expect(second.status).toBe(200);
  expect(second.headers.get('content-type')).toContain('utf-8');
  expect(await second.text()).toBe(firstText);
});
