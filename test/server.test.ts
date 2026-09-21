import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { afterEach, expect, test } from 'vitest';
import { Cache } from '../src/cache';
import type { Config } from '../src/config';
import { createApp } from '../src/routes';
import type { RawSub } from '../src/sources';
import cues from './fixtures/cues.json' with { type: 'json' };

/**
 * These tests go over real HTTP, through `@hono/node-server`, because that adapter does
 * things `app.request()` never does - including writing `Content-Length` into the header
 * object a handler passes to `c.body()`. A shared header constant therefore worked in every
 * unit test and returned 500 on the second request in production. Anything about how a
 * response is *sent* belongs here rather than in routes.test.ts.
 */

const TOKEN = 'testtoken';
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
  ['Prison.Break.S01E6.DVDRIP.SAINTS', cues['DVDRIP.SAINTS']],
];

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function startServer(): Promise<string> {
  const subs: RawSub[] = CATALOGUE.map(([name], i) => ({
    id: `wizdom:${i}`,
    source: 'wizdom' as const,
    lang: 'he',
    name,
    url: `http://w/${i}.srt`,
  }));

  const app = createApp({
    cfg,
    cache: new Cache(mkdtempSync(join(tmpdir(), 'subfit-http-'))),
    log: () => {},
    fetchAll: async () => ({ subs, errors: [] }),
    fetchBody: async (url: string) => {
      const i = Number(/\/(\d+)\.srt$/.exec(url)?.[1] ?? -1);
      const entry = CATALOGUE[i];
      if (!entry) throw new Error('no such fixture');
      return srtFor(entry[1]);
    },
  });

  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const { port } = server.address() as AddressInfo;
  close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

test('a subtitle can be fetched repeatedly over real HTTP', async () => {
  const base = await startServer();

  const list = (await (
    await fetch(`${base}/${TOKEN}/subtitles/series/tt0455275:1:6/filename=${BLURAY_FILE}.json`)
  ).json()) as { subtitles: { url: string }[] };
  const url = list.subtitles[1]?.url as string;

  const first = await fetch(url);
  expect(first.status).toBe(200);
  const body = await first.text();

  // The one that used to 500: the response headers object had been mutated by the adapter.
  const second = await fetch(url);
  expect(second.status).toBe(200);
  expect(await second.text()).toBe(body);

  const third = await fetch(url);
  expect(third.status).toBe(200);
  expect(third.headers.get('content-type')).toContain('utf-8');
});

test('the subtitle list can be requested repeatedly over real HTTP', async () => {
  const base = await startServer();
  const url = `${base}/${TOKEN}/subtitles/series/tt0455275:1:6/filename=${BLURAY_FILE}.json`;

  for (let i = 0; i < 3; i++) {
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { subtitles: unknown[] }).subtitles.length).toBeGreaterThan(0);
  }
});

test('the manifest can be requested repeatedly over real HTTP', async () => {
  const base = await startServer();

  for (let i = 0; i < 3; i++) {
    const res = await fetch(`${base}/${TOKEN}/manifest.json`);
    expect(res.status).toBe(200);
  }
});
