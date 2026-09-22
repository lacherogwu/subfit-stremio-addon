import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { loadConfig } from '../src/config';

const freshDir = (): string => mkdtempSync(join(tmpdir(), 'subfit-'));

test('creates config.json with a token on first run, and keeps it after', () => {
  const dir = freshDir();
  const first = loadConfig(dir);
  expect(first.token).toMatch(/^[0-9a-f]{32}$/);
  expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).token).toBe(first.token);
  expect(loadConfig(dir).token).toBe(first.token);
});

test('ships a working default: one public source, one language', () => {
  const cfg = loadConfig(freshDir());
  expect(cfg.port).toBe(18702);
  expect(cfg.languages).toEqual(['en']);
  expect(cfg.sources).toHaveLength(1);
  expect(cfg.sources[0]?.url).toMatch(/^https:\/\//);
});

test('any number of sources can be configured, in any order', () => {
  const dir = freshDir();
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({
      sources: [
        { name: 'wizdom', url: 'https://example.com/wizdom' },
        { name: 'my-own-instance', url: 'https://subs.example.com/x' },
      ],
    }),
  );
  const cfg = loadConfig(dir);
  expect(cfg.sources.map((s) => s.name)).toEqual(['wizdom', 'my-own-instance']);
});

test('an older config with named source keys is converted, not discarded', () => {
  // Dropping someone's configured upstreams on upgrade would leave them wondering where
  // their subtitles went.
  const dir = freshDir();
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({
      sources: { wizdom: 'https://example.com/w', ktuvit: 'https://example.com/k' },
    }),
  );
  const cfg = loadConfig(dir);
  expect(cfg.sources).toEqual([
    { name: 'wizdom', url: 'https://example.com/w' },
    { name: 'ktuvit', url: 'https://example.com/k' },
  ]);
  expect(cfg.configIssues.join(' ')).toContain('converted');
});

test('a bad field falls back to its default and is reported, rather than crashing', () => {
  const dir = freshDir();
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({ port: 'not a number', languages: ['he'] }),
  );
  const cfg = loadConfig(dir);
  expect(cfg.port).toBe(18702);
  expect(cfg.languages).toEqual(['he']);
  expect(cfg.configIssues.join(' ')).toContain('port');
});
