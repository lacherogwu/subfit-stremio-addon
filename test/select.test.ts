import { expect, test } from 'vitest';
import type { CatalogueEntry } from '../src/catalogue';
import { classify } from '../src/classify';
import { select } from '../src/select';
import cues from './fixtures/cues.json' with { type: 'json' };

const entry = (
  name: string,
  timings: number[] | undefined,
  lang = 'he',
  id = name,
): CatalogueEntry => ({
  id,
  source: 'wizdom',
  lang,
  name,
  url: `http://w/${id}.srt`,
  release: classify(name),
  ...(timings ? { cues: timings } : {}),
});

const BLURAY = entry('Prison.Break.S01E06.720p.BluRay.x264-HALCYON', cues.HALCYON);
const BLURAY_2 = entry('Prison.Break.S01E06.720p.BluRay.DTS.x264-ESiR', cues.ESiR);
const DVD = entry('Prison.Break.S01E6.DVDRIP.SAINTS', cues['DVDRIP.SAINTS']);
const HDTV = entry('Prison.Break.S01E6.hdtv-LOL', cues['hdtv-LOL']);

test('a subtitle from the target family is served as-is, with a tick', () => {
  const { list } = select([BLURAY, BLURAY_2], classify('Show.1080p.BluRay.x264-AAA'), ['he']);
  expect(list[0]?.state).toBe('match');
  expect(list[0]?.label).toContain('✅');
  expect(list[0]?.label).toContain('BluRay');
  expect(list[0]?.transform).toBeUndefined();
});

test('a PAL DVD sub is re-timed onto a BluRay file, with the measured stretch', () => {
  const { list } = select([BLURAY, DVD], classify('Show.1080p.BluRay.x264-AAA'), ['he']);
  const dvd = list.find((d) => d.entry.name.includes('DVDRIP'));
  expect(dvd?.state).toBe('retimed');
  expect(dvd?.transform?.scale).toBeCloseTo(25 / 23.976, 3);
  expect(dvd?.label).toContain('DVD→BluRay');
});

test('HDTV against a BluRay file is labelled as a mismatch, never re-timed', () => {
  const { list } = select([BLURAY, HDTV], classify('Show.1080p.BluRay.x264-AAA'), ['he']);
  const hdtv = list.find((d) => d.entry.name.includes('hdtv'));
  expect(hdtv?.state).toBe('mismatch');
  expect(hdtv?.transform).toBeUndefined();
  expect(hdtv?.label).toContain('⚠️');
  expect(hdtv?.label).toContain('HDTV');
});

test('a WEB file with a BluRay-only catalogue gets mismatches and no star', () => {
  const target = classify('Prison.Break.S01E06.1080p.DSNP.WEB-DL.DDP5.1.H.264-playWEB.mkv');
  const { list, stars } = select([BLURAY, BLURAY_2, DVD, HDTV], target, ['he']);
  expect(list.every((d) => d.state === 'mismatch')).toBe(true);
  expect(stars).toEqual([]);
});

test('nothing is ever dropped from the list', () => {
  const target = classify('Prison.Break.S01E06.1080p.DSNP.WEB-DL-playWEB.mkv');
  const { list } = select([BLURAY, BLURAY_2, DVD, HDTV], target, ['he']);
  expect(list).toHaveLength(4);
});

test('one star per language, and only from a match or a re-timing', () => {
  const english = entry('Prison.Break.S01E06.720p.BluRay.x264-HALCYON', cues.HALCYON, 'en', 'en-1');
  const { stars } = select([BLURAY, english, HDTV], classify('Show.720p.BluRay-X'), ['en', 'he']);
  expect(stars.map((s) => s.entry.lang)).toEqual(['en', 'he']);
  expect(stars.every((s) => s.state === 'match')).toBe(true);
  expect(stars.every((s) => s.label.startsWith('⭐'))).toBe(true);
});

test('a star falls back to a re-timed subtitle when that language has no exact match', () => {
  // Timing is language-agnostic, so an English BluRay subtitle is a perfectly good
  // reference for deciding how to move a Hebrew DVD subtitle onto a BluRay file.
  const englishReference = entry(
    'Prison.Break.S01E06.720p.BluRay.x264-HALCYON',
    cues.HALCYON,
    'en',
    'en-ref',
  );
  const { stars } = select([englishReference, DVD, HDTV], classify('Show.1080p.BluRay.x264-AAA'), [
    'he',
  ]);
  expect(stars).toHaveLength(1);
  expect(stars[0]?.entry.lang).toBe('he');
  expect(stars[0]?.state).toBe('retimed');
});

test("with no reference of the file's family, nothing is re-timed and nothing is starred", () => {
  // There is no way to measure a correction without something correctly timed to measure
  // against, and guessing one would be worse than admitting it.
  const { list, stars } = select([DVD, HDTV], classify('Show.1080p.BluRay.x264-AAA'), ['he']);
  expect(list.every((d) => d.state === 'mismatch')).toBe(true);
  expect(stars).toEqual([]);
});

test('an entry with no timing falls back to its name, and stays visible', () => {
  const nameless = entry('Prison.Break.S01E06.720p.BluRay.x264-CtrlHD', undefined);
  const { list } = select([nameless], classify('Show.1080p.BluRay-AAA'), ['he']);
  expect(list[0]?.state).toBe('match');
  expect(list[0]?.label).toContain('BluRay');
});

test('an unclassifiable subtitle against an unclassifiable file is labelled unknown', () => {
  const vague = entry('Prison Break S01E06 - Riots, Drills, and the Devil', undefined);
  const { list, stars } = select([vague], classify('some.file.mkv'), ['he']);
  expect(list[0]?.state).toBe('unknown');
  expect(list[0]?.label).toContain('❔');
  expect(stars).toEqual([]);
});

test('duplicates are collapsed out of the served list', () => {
  const twin: CatalogueEntry = { ...BLURAY_2, id: 'twin', duplicateOf: BLURAY.id };
  const { list } = select([BLURAY, twin], classify('Show.720p.BluRay-X'), ['he']);
  expect(list).toHaveLength(1);
  expect(list[0]?.entry.id).toBe(BLURAY.id);
});

test('same release group wins the tie for the star', () => {
  const other = entry('Prison.Break.S01E06.720p.BluRay.DTS.x264-ESiR', cues.ESiR, 'he', 'other');
  const { stars } = select(
    [other, BLURAY],
    classify('Prison.Break.S01E06.1080p.BluRay.x264-HALCYON'),
    ['he'],
  );
  expect(stars[0]?.entry.id).toBe(BLURAY.id);
});

test('a verdict reached by measurement says so, and one from a name does not', () => {
  const { list } = select([BLURAY, BLURAY_2, DVD], classify('Show.1080p.BluRay.x264-AAA'), ['he']);
  const measured = list.find((d) => d.entry.id === BLURAY.id);
  expect(measured?.via).toBe('timing');
  expect(measured?.label).toContain('verified');

  const nameOnly = select(
    [entry('Show.720p.BluRay-X', undefined)],
    classify('Show.1080p.BluRay-AAA'),
    ['he'],
  );
  expect(nameOnly.list[0]?.via).toBe('name');
  expect(nameOnly.list[0]?.label).not.toContain('verified');
});
