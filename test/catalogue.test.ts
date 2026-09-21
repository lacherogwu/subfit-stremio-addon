import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { Cache } from '../src/cache';
import { buildCatalogue, type CatalogueDeps } from '../src/catalogue';
import type { Config } from '../src/config';
import type { RawSub } from '../src/sources';
import cues from './fixtures/cues.json' with { type: 'json' };

const cfg: Config = {
  port: 0,
  baseUrl: '',
  token: 't',
  logFile: '',
  sources: { wizdom: 'http://w', ktuvit: 'http://k', opensubtitles: 'http://o' },
  languages: ['en', 'he', 'ru'],
  deadlineMs: 5000,
  configIssues: [],
};

/** Rebuilds an SRT body from a fixture's cue-start vector, which is all the timing needs. */
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

const WIZDOM_SEVEN: [string, number[]][] = [
  ['prison.break.106.hdtv-lol.VO', cues['hdtv-lol.VO']],
  ['Prison.Break.S01E06.720p.BluRay.DTS.x264-ESiR', cues.ESiR],
  ['Prison.Break.S01E06.720p.BluRay.x264-HALCYON', cues.HALCYON],
  [
    'Prison.Break.S01E06.Riots,.Drills.and.the.Devil.(1).720p.BluRay.x264-HALCYON',
    cues['Riots,Drills.HALCYON'],
  ],
  ['Prison.Break.S01E6.DVDRIP.SAINTS', cues['DVDRIP.SAINTS']],
  ['Prison.Break.S01E6.hdtv-LOL', cues['hdtv-LOL']],
];

const depsFor = (entries: [string, number[]][], opts: { dead?: string } = {}): CatalogueDeps => {
  const subs: RawSub[] = entries.map(([name], i) => ({
    id: `wizdom:${i}`,
    source: 'wizdom',
    lang: 'he',
    name,
    url: name === opts.dead ? 'http://dead/x.srt' : `http://w/${i}.srt`,
  }));
  return {
    cache: new Cache(mkdtempSync(join(tmpdir(), 'subfit-cat-'))),
    fetchAll: async () => ({ subs, errors: [] }),
    fetchBody: async (url: string) => {
      if (url.includes('dead')) throw new Error('connection refused');
      const i = Number(/\/(\d+)\.srt$/.exec(url)?.[1] ?? -1);
      const entry = entries[i];
      if (!entry) throw new Error('no such fixture');
      return srtFor(entry[1]);
    },
  };
};

test('seven wizdom entries collapse to four distinct timings', async () => {
  const { entries } = await buildCatalogue(
    depsFor(WIZDOM_SEVEN),
    cfg,
    'series',
    'tt0455275:1:6',
    '',
  );
  const distinct = entries.filter((e) => !e.duplicateOf);
  expect(entries).toHaveLength(6);
  expect(distinct).toHaveLength(4);
});

test('the duplicate pairs are the ones measured, and each points at its twin', async () => {
  const { entries } = await buildCatalogue(
    depsFor(WIZDOM_SEVEN),
    cfg,
    'series',
    'tt0455275:1:6',
    '',
  );
  const byName = (part: string) => entries.find((e) => e.name.includes(part));

  const vo = byName('hdtv-lol.VO');
  const lol = byName('hdtv-LOL');
  const riots = byName('Riots');
  const esir = byName('ESiR');

  expect([vo?.duplicateOf, lol?.duplicateOf].filter(Boolean)).toHaveLength(1);
  expect([riots?.duplicateOf, esir?.duplicateOf].filter(Boolean)).toHaveLength(1);
});

test('same-family subs share a cluster and HDTV sits in its own', async () => {
  const { entries } = await buildCatalogue(
    depsFor(WIZDOM_SEVEN),
    cfg,
    'series',
    'tt0455275:1:6',
    '',
  );
  const esir = entries.find((e) => e.name.includes('ESiR'));
  const halcyon = entries.find((e) => e.name.includes('x264-HALCYON'));
  const hdtv = entries.find((e) => e.name.includes('hdtv-LOL'));

  expect(esir?.cluster).toBe(halcyon?.cluster);
  expect(hdtv?.cluster).not.toBe(esir?.cluster);
});

test('a PAL DVD subtitle gets its own cluster, although it matches after a stretch', async () => {
  // Clustering answers "do these play in sync as they are?", not "could they be made to".
  // Conflating the two would let a subtitle that needs a correction be served without one.
  const { entries } = await buildCatalogue(
    depsFor(WIZDOM_SEVEN),
    cfg,
    'series',
    'tt0455275:1:6',
    '',
  );
  const dvd = entries.find((e) => e.name.includes('DVDRIP'));
  const bluray = entries.find((e) => e.name.includes('ESiR'));
  expect(dvd?.cluster).toBeDefined();
  expect(dvd?.cluster).not.toBe(bluray?.cluster);
});

test('every entry is classified, including the ones that turned out to be duplicates', async () => {
  const { entries } = await buildCatalogue(
    depsFor(WIZDOM_SEVEN),
    cfg,
    'series',
    'tt0455275:1:6',
    '',
  );
  expect(entries.map((e) => e.release.family).sort()).toEqual(
    ['BluRay', 'BluRay', 'BluRay', 'DVD', 'HDTV', 'HDTV'].sort(),
  );
});

test('a body that fails to download keeps its entry, name-classified and cueless', async () => {
  const deps = depsFor(WIZDOM_SEVEN, { dead: 'Prison.Break.S01E06.720p.BluRay.DTS.x264-ESiR' });
  const { entries } = await buildCatalogue(deps, cfg, 'series', 'tt0455275:1:6', '');
  const dead = entries.find((e) => e.name.includes('ESiR'));

  expect(dead).toBeDefined();
  expect(dead?.cues).toBeUndefined();
  expect(dead?.release.family).toBe('BluRay');
});

test('a second call is served from the cache without re-fetching', async () => {
  const deps = depsFor(WIZDOM_SEVEN);
  let calls = 0;
  const counting: CatalogueDeps = {
    ...deps,
    fetchAll: async (...args) => {
      calls++;
      return deps.fetchAll(...args);
    },
  };

  await buildCatalogue(counting, cfg, 'series', 'tt0455275:1:6', '');
  const second = await buildCatalogue(counting, cfg, 'series', 'tt0455275:1:6', '');

  expect(calls).toBe(1);
  expect(second.entries.filter((e) => !e.duplicateOf)).toHaveLength(4);
});

test('upstream errors travel with the catalogue rather than being swallowed', async () => {
  const deps: CatalogueDeps = {
    ...depsFor(WIZDOM_SEVEN),
    fetchAll: async () => ({ subs: [], errors: ['wizdom: HTTP 500'] }),
  };
  const { entries, errors } = await buildCatalogue(deps, cfg, 'series', 'tt0455275:1:6', '');
  expect(entries).toEqual([]);
  expect(errors).toEqual(['wizdom: HTTP 500']);
});
