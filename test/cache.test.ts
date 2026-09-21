import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { Cache } from '../src/cache';

const freshCache = (): Cache => new Cache(mkdtempSync(join(tmpdir(), 'subfit-cache-')));

test('round-trips a subtitle body and its cue vector', () => {
  const c = freshCache();
  c.putBody('wizdom:1', Buffer.from('hello'), [1, 2, 3]);
  expect(c.getBody('wizdom:1')).toEqual(Buffer.from('hello'));
  expect(c.getCues('wizdom:1')).toEqual([1, 2, 3]);
});

test('misses cleanly for something never stored', () => {
  const c = freshCache();
  expect(c.getBody('nope')).toBeNull();
  expect(c.getCues('nope')).toBeNull();
  expect(c.getCatalogue('nope')).toBeNull();
  expect(c.getRetimed('nope')).toBeNull();
});

test('a catalogue expires after its ttl, a body does not', () => {
  const c = freshCache();
  const now = Date.now();
  c.putCatalogue('tt1:1:1', [{ id: 'a' }], now);
  c.putBody('wizdom:1', Buffer.from('x'), [1], now);

  const sixHoursOn = now + 6 * 3600_000 + 1000;
  expect(c.getCatalogue('tt1:1:1', sixHoursOn)).toBeNull();
  expect(c.getBody('wizdom:1', sixHoursOn)).toEqual(Buffer.from('x'));
});

test('sweep deletes expired rows and keeps live ones', () => {
  const c = freshCache();
  const now = Date.now();
  c.putCatalogue('old', [{ id: 'a' }], now);
  c.putCatalogue('new', [{ id: 'b' }], now + 5 * 3600_000);

  c.sweep(now + 6 * 3600_000 + 1000);

  expect(c.getCatalogue('old', now)).toBeNull();
  expect(c.getCatalogue('new', now + 5 * 3600_000)).toEqual([{ id: 'b' }]);
});

test('stores a re-timed body under its own key', () => {
  const c = freshCache();
  c.putRetimed('wizdom:1|BluRay', Buffer.from('shifted'));
  expect(c.getRetimed('wizdom:1|BluRay')).toEqual(Buffer.from('shifted'));
  expect(c.getRetimed('wizdom:1|WEB')).toBeNull();
});

test('remembers what a served subtitle url points at', () => {
  const c = freshCache();
  c.putRef('abc123', { url: 'http://w/1.srt', scale: 1.042, offset: 0.4 });
  expect(c.getRef('abc123')).toEqual({ url: 'http://w/1.srt', scale: 1.042, offset: 0.4 });
  expect(c.getRef('missing')).toBeNull();
});

test('survives being reopened on the same directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'subfit-cache-'));
  new Cache(dir).putBody('wizdom:1', Buffer.from('persisted'), [1]);
  expect(new Cache(dir).getBody('wizdom:1')).toEqual(Buffer.from('persisted'));
});
