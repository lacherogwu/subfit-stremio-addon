import { afterEach, expect, test } from 'vitest';
import type { Config } from '../src/config';
import { fetchAll } from '../src/sources';
import { type Stub, startStub } from './helpers/stub';

const stubs: Stub[] = [];
afterEach(async () => {
  await Promise.all(stubs.splice(0).map((s) => s.close()));
});

const cfgFor = (wizdom: string, ktuvit: string, opensubtitles: string): Config => ({
  port: 0,
  baseUrl: '',
  token: 't',
  logFile: '',
  sources: [
    { name: 'wizdom', url: wizdom },
    { name: 'ktuvit', url: ktuvit },
    { name: 'opensubtitles', url: opensubtitles },
  ],
  languages: ['en', 'he', 'ru'],
  deadlineMs: 5000,
  configIssues: [],
});

const track = async (routes: Record<string, unknown>): Promise<Stub> => {
  const s = await startStub(routes);
  stubs.push(s);
  return s;
};

test('merges the upstreams and strips their id prefixes', async () => {
  const w = await track({
    '/subtitles': {
      subtitles: [
        {
          id: '[WIZDOM]Prison.Break.S01E06.720p.BluRay.x264-HALCYON',
          url: 'http://x/1.srt',
          lang: 'heb',
        },
      ],
    },
  });
  const k = await track({ '/subtitles': { subtitles: [] } });
  const o = await track({
    '/subtitles': {
      subtitles: [
        { id: 'v3+|123|Prison.Break.S01E06.HDTV.XviD-LOL', url: 'http://x/2.srt', lang: 'eng' },
      ],
    },
  });

  const { subs, errors } = await fetchAll(
    cfgFor(w.url, k.url, o.url),
    'series',
    'tt0455275:1:6',
    '',
  );

  expect(errors).toEqual([]);
  expect(subs.map((s) => s.name)).toEqual([
    'Prison.Break.S01E06.720p.BluRay.x264-HALCYON',
    'Prison.Break.S01E06.HDTV.XviD-LOL',
  ]);
  expect(subs.map((s) => s.lang)).toEqual(['he', 'en']);
  expect(subs.map((s) => s.source)).toEqual(['wizdom', 'opensubtitles']);
});

test('one failing upstream does not lose the others, and is reported', async () => {
  const w = await track({ '/subtitles': 500 });
  const k = await track({
    '/subtitles': {
      subtitles: [{ id: '[KTUVIT]Show.720p.BluRay-X', url: 'http://x/3.srt', lang: 'heb' }],
    },
  });
  const o = await track({ '/subtitles': { subtitles: [] } });

  const { subs, errors } = await fetchAll(
    cfgFor(w.url, k.url, o.url),
    'series',
    'tt0455275:1:6',
    '',
  );

  expect(subs).toHaveLength(1);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain('wizdom');
});

test('forwards the extras verbatim, because that is what the matching depends on', async () => {
  const extras = 'videoHash=da82257326ccae25&videoSize=2679739036&filename=Show.mkv';
  const w = await track({ '/subtitles': { subtitles: [] } });
  const k = await track({ '/subtitles': { subtitles: [] } });
  const o = await track({ '/subtitles': { subtitles: [] } });

  await fetchAll(cfgFor(w.url, k.url, o.url), 'series', 'tt0455275:1:6', extras);

  expect(w.requests[0]).toBe(`/subtitles/series/tt0455275:1:6/${extras}.json`);
});

test('omits the extras segment entirely when there are none', async () => {
  const w = await track({ '/subtitles': { subtitles: [] } });
  const k = await track({ '/subtitles': { subtitles: [] } });
  const o = await track({ '/subtitles': { subtitles: [] } });

  await fetchAll(cfgFor(w.url, k.url, o.url), 'movie', 'tt0133093', '');

  expect(w.requests[0]).toBe('/subtitles/movie/tt0133093.json');
});

test('drops languages that were not asked for', async () => {
  const w = await track({
    '/subtitles': {
      subtitles: [
        { id: '[WIZDOM]A.720p.BluRay-X', url: 'http://x/1.srt', lang: 'heb' },
        { id: '[WIZDOM]B.720p.BluRay-X', url: 'http://x/2.srt', lang: 'pol' },
      ],
    },
  });
  const k = await track({ '/subtitles': { subtitles: [] } });
  const o = await track({ '/subtitles': { subtitles: [] } });

  const { subs } = await fetchAll(cfgFor(w.url, k.url, o.url), 'series', 'tt1:1:1', '');

  expect(subs.map((s) => s.lang)).toEqual(['he']);
});
