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

test('ships working defaults for the upstream addons', () => {
  const cfg = loadConfig(freshDir());
  expect(cfg.port).toBe(18702);
  expect(cfg.languages).toEqual(['en', 'he', 'ru']);
  expect(cfg.sources.wizdom).toMatch(/^https:\/\//);
  expect(cfg.sources.ktuvit).toMatch(/^https:\/\//);
  expect(cfg.sources.opensubtitles).toMatch(/^https:\/\//);
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
