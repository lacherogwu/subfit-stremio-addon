import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { Cache } from '../src/cache';
import type { Config } from '../src/config';
import { createApp } from '../src/routes';
import type { RawSub } from '../src/sources';
import cues from './fixtures/cues.json' with { type: 'json' };

/**
 * There are too many titles, releases and upstream moods to test one by one, so this file
 * tests the *ways things go wrong* instead. Every case here asserts the same two promises:
 *
 *   - nothing is reported that was not established, and
 *   - nothing that exists is hidden.
 *
 * A subtitle nobody could check must say so rather than be condemned or quietly dropped.
 */

const TOKEN = 'testtoken';
const BLURAY = 'Prison.Break.S01E06.1080p.BluRay.x264-MIXED.mkv';

const cfg: Config = {
  port: 0,
  baseUrl: '',
  token: TOKEN,
  logFile: '',
  sources: [{ name: 'upstream', url: 'http://u' }],
  languages: ['en', 'he', 'ru'],
  deadlineMs: 2000,
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

interface Case {
  subs?: RawSub[];
  errors?: string[];
  body?: (url: string) => Promise<Buffer>;
}

const sub = (id: string, name: string, lang = 'he'): RawSub => ({
  id,
  source: 'upstream',
  lang,
  name,
  url: `http://u/${id}.srt`,
});

const appFor = (c: Case) =>
  createApp({
    cfg,
    cache: new Cache(mkdtempSync(join(tmpdir(), 'subfit-degraded-'))),
    log: () => {},
    fetchAll: async () => ({ subs: c.subs ?? [], errors: c.errors ?? [] }),
    fetchBody: c.body ?? (async () => srtFor(cues.HALCYON)),
  });

const menu = async (app: ReturnType<typeof createApp>, file = BLURAY) => {
  const res = await app.request(
    `/${TOKEN}/subtitles/series/tt0455275:1:6/filename=${encodeURIComponent(file)}.json`,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { subtitles: { id: string; lang: string; url: string }[] };
};

test('every upstream failing says so, and does not look like "no subtitles exist"', async () => {
  const body = await menu(appFor({ errors: ['upstream: took too long, skipped'] }));
  expect(body.subtitles.length).toBeGreaterThan(0);
  expect(body.subtitles.some((s) => s.id.includes('❌') && s.id.includes('upstream'))).toBe(true);
});

test('one upstream failing still serves the others, and still says what failed', async () => {
  const body = await menu(
    appFor({
      subs: [sub('a', 'Prison.Break.S01E06.720p.BluRay.x264-HALCYON')],
      errors: ['other: HTTP 500'],
    }),
  );
  expect(body.subtitles.some((s) => s.id.includes('HALCYON'))).toBe(true);
  expect(body.subtitles.some((s) => s.id.includes('❌'))).toBe(true);
});

test('a subtitle whose body cannot be downloaded is offered, not dropped', async () => {
  const body = await menu(
    appFor({
      subs: [sub('a', 'Prison.Break.S01E06.720p.BluRay.x264-HALCYON')],
      body: async () => {
        throw new Error('connection reset');
      },
    }),
  );
  expect(body.subtitles.some((s) => s.id.includes('HALCYON'))).toBe(true);
});

test('a body that is not a subtitle at all is offered, labelled by its name', async () => {
  const body = await menu(
    appFor({
      subs: [
        sub('a', 'Prison.Break.S01E06.720p.BluRay.x264-HALCYON'),
        sub('b', 'Prison.Break.S01E06.720p.BluRay.x264-ESiR'),
      ],
      body: async (url) =>
        url.includes('/a.srt') ? Buffer.from('<html>not a subtitle</html>') : srtFor(cues.ESiR),
    }),
  );
  const broken = body.subtitles.find((s) => s.id.includes('HALCYON'));
  expect(broken).toBeDefined();
  expect(broken?.id).toContain('✅ likely');
});

test('a subtitle too short to measure is unchecked, never "wrong release"', async () => {
  // Forced subtitles for a few foreign lines cannot be told from a coincidence by any
  // amount of correlation. Condemning one would be reporting a verdict nobody reached.
  const body = await menu(
    appFor({
      subs: [
        sub('forced', 'Prison.Break.S01E06.FORCED'),
        sub('full', 'Prison.Break.S01E06.720p.BluRay.x264-HALCYON'),
        sub('full2', 'Prison.Break.S01E06.720p.BluRay.x264-ESiR'),
      ],
      body: async (url) =>
        url.includes('forced') ? srtFor([120, 340, 900]) : srtFor(cues.HALCYON),
    }),
  );
  const forced = body.subtitles.find((s) => s.id.includes('FORCED'));
  expect(forced).toBeDefined();
  expect(forced?.id).not.toContain('wrong release');
});

test('an empty upstream is an empty menu, not an error', async () => {
  const body = await menu(appFor({ subs: [], errors: [] }));
  expect(body.subtitles).toEqual([]);
});

test('a player that sends no filename still gets every subtitle, and no false stars', async () => {
  const app = appFor({
    subs: [
      sub('a', 'Prison.Break.S01E06.720p.BluRay.x264-HALCYON'),
      sub('b', 'Prison.Break.S01E6.DVDRIP.SAINTS'),
    ],
    // Distinct bodies, or the two collapse into one - which is dedupe working, not the
    // behaviour under test here.
    body: async (url) =>
      url.includes('/a.srt') ? srtFor(cues.HALCYON) : srtFor(cues['DVDRIP.SAINTS']),
  });
  const res = await app.request(`/${TOKEN}/subtitles/series/tt0455275:1:6.json`);
  const body = (await res.json()) as { subtitles: { id: string }[] };

  expect(body.subtitles).toHaveLength(2);
  // Nothing is known about the file, so nothing may be recommended for it.
  expect(body.subtitles.every((s) => !s.id.includes('⭐'))).toBe(true);
  expect(body.subtitles.every((s) => s.id.includes('❔'))).toBe(true);
});

test('a release nobody can classify gets no verdicts on the card', async () => {
  const app = appFor({ subs: [sub('a', 'Prison.Break.S01E06.720p.BluRay.x264-HALCYON')] });
  await menu(app);
  const fits = (await (await app.request(`/${TOKEN}/fit/series/tt0455275:1:6`)).json()) as Record<
    string,
    Record<string, string>
  >;
  // The lookup answers per family; an unidentifiable release simply finds no entry, and the
  // patch renders no row rather than inventing one.
  expect(fits.he?.unknown).toBeUndefined();
});

test('the family lookup is silent rather than wrong while nothing is known', async () => {
  const app = appFor({ subs: [sub('a', 'Prison.Break.S01E06.720p.BluRay.x264-HALCYON')] });
  const fits = await (await app.request(`/${TOKEN}/fit/series/tt0455275:1:6`)).json();
  expect(fits).toEqual({});
});

test('when a subtitle server is down, an identical subtitle stands in for it', async () => {
  // Observed in the wild: a subtitle site returned 504 for one file, the player retried ten
  // times, and the viewer got nothing — while a byte-identical copy sat one source away.
  const twins: RawSub[] = [
    { ...sub('dead', 'Prison.Break.S01E08.1080p.BluRay.DTS.x264-CtrlHD'), source: 'ktuvit' },
    { ...sub('alive', 'Prison.Break.S01E08.720p.BluRay.x264-CtrlHD'), source: 'wizdom' },
  ];

  let serveDead = true;
  const app = createApp({
    cfg,
    cache: new Cache(mkdtempSync(join(tmpdir(), 'subfit-standin-'))),
    log: () => {},
    fetchAll: async () => ({ subs: twins, errors: [] }),
    fetchBody: async (url: string) => {
      if (url.includes('dead') && !serveDead) throw new Error('HTTP 504');
      return srtFor(cues.HALCYON);
    },
  });

  const list = await menu(app);
  const chosen = list.subtitles.find((s) => s.url.includes('/sub/'));
  expect(chosen).toBeDefined();

  // The catalogue is built; now the site hosting the chosen file goes down.
  serveDead = false;
  const res = await app.request(new URL(chosen?.url ?? '').pathname);

  expect(res.status).toBe(200);
  expect(await res.text()).toContain('-->');
});

test('with no stand-in available, the failure is reported rather than faked', async () => {
  const app = createApp({
    cfg,
    cache: new Cache(mkdtempSync(join(tmpdir(), 'subfit-nostandin-'))),
    log: () => {},
    fetchAll: async () => ({
      subs: [sub('only', 'Prison.Break.S01E08.1080p.BluRay.x264-CtrlHD')],
      errors: [],
    }),
    fetchBody: async () => {
      throw new Error('HTTP 504');
    },
  });

  const list = await menu(app);
  const chosen = list.subtitles.find((s) => s.url.includes('/sub/'));
  const res = await app.request(new URL(chosen?.url ?? '').pathname);
  expect(res.status).toBe(502);
});
