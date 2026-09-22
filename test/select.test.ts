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

test('an entry with no timing falls back to its name when something corroborates it', () => {
  const nameless = entry('Prison.Break.S01E06.720p.BluRay.x264-CtrlHD', undefined);
  const { list } = select([nameless, BLURAY], classify('Show.1080p.BluRay-AAA'), ['he']);
  const it = list.find((d) => d.entry.name.includes('CtrlHD'));
  expect(it?.state).toBe('match');
  expect(it?.label).toContain('likely');
  expect(it?.label).toContain('BluRay');
});

test('but a name-based match is kept when other subtitles of that family exist', () => {
  const namedOnly = entry('Show.S01E01.1080p.WEB-DL-AAA', undefined, 'ru', 'named');
  const webWithTiming = entry('Show.S01E01.1080p.WEB-DL-BBB', cues.ESiR, 'en', 'web-en');
  const { list } = select(
    [namedOnly, webWithTiming],
    classify('Show.S01E01.1080p.WEB-DL-CCC.mkv'),
    ['en', 'ru'],
  );
  expect(list.find((d) => d.entry.id === 'named')?.state).toBe('match');
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

test('a subtitle from a different show is unchecked, whatever its filename claims', () => {
  // Subtitle sites file the occasional entry under the wrong show. One such entry was being
  // advertised as the best Russian match for an episode of a series it is not from, on the
  // strength of its own filename. Its timings belong elsewhere, so it lines up with nothing
  // here — which is what gives it away.
  const elsewhere = cues.HALCYON.map((t) => t * 1.37 + 211);
  const impostor = entry('Prison.Break.Sequel.s01e06.WEB-DL.720p', elsewhere, 'ru', 'impostor');
  const real = entry('Prison.Break.S01E06.720p.BluRay.x264-HALCYON', cues.HALCYON, 'he', 'real');

  const { list, stars } = select(
    [impostor, real],
    classify('Prison.Break.S01E06.1080p.WEB-DL-X.mkv'),
    ['he', 'ru'],
  );

  const judged = list.find((d) => d.entry.id === 'impostor');
  expect(judged?.state).toBe('unknown');
  expect(judged?.label).toContain('unchecked');
  expect(stars.some((s) => s.entry.lang === 'ru')).toBe(false);
});

test('a subtitle that lines up with the episode is trusted, though nothing shares its release', () => {
  // The stricter version of this rule asked whether anything else claimed the same release,
  // and withheld four good recommendations for every bad one it caught. Belonging to the
  // episode is the question worth asking.
  const onlyWeb = entry('Show.S01E01.1080p.WEB-DL-AAA', cues.HALCYON, 'he', 'web');
  const other = entry('Show.S01E01.720p.BluRay-BBB', cues.HALCYON, 'en', 'bluray');

  const { list, stars } = select([onlyWeb, other], classify('Show.S01E01.1080p.WEB-DL-CCC.mkv'), [
    'he',
  ]);

  expect(list.find((d) => d.entry.id === 'web')?.state).toBe('match');
  expect(stars).toHaveLength(1);
});

test('a language with something that works drops what was measured not to', () => {
  // Known-wrong subtitles exist only to be tried and rejected, and on a phone they render
  // as unlabelled rows indistinguishable from the good ones.
  const { list } = select([BLURAY, BLURAY_2, HDTV], classify('Show.1080p.BluRay.x264-AAA'), ['he']);
  expect(list.some((d) => d.state === 'match')).toBe(true);
  expect(list.some((d) => d.state === 'mismatch')).toBe(false);
});

test('a language with nothing that works keeps everything', () => {
  // The least-bad option is still the only option.
  const target = classify('Prison.Break.S01E06.1080p.DSNP.WEB-DL-playWEB.mkv');
  const { list } = select([BLURAY, HDTV, DVD], target, ['he']);
  expect(list).toHaveLength(3);
  expect(list.every((d) => d.state === 'mismatch')).toBe(true);
});

test('what could not be checked is kept as a suggestion, below what works', () => {
  const unverifiable = entry('Prison Break S01E06', undefined, 'he', 'vague');
  const { list } = select(
    [BLURAY, BLURAY_2, unverifiable, HDTV],
    classify('Show.1080p.BluRay.x264-AAA'),
    ['he'],
  );
  const states = list.map((d) => d.state);
  expect(states).toContain('unknown');
  expect(states).not.toContain('mismatch');
  // Known-good first, unchecked after.
  expect(states.indexOf('unknown')).toBeGreaterThan(states.lastIndexOf('match'));
});

test('dropping is per language, not across the menu', () => {
  const englishWorks = entry('Show.720p.BluRay-EN', cues.HALCYON, 'en', 'en-ok');
  // Something for the English one to be corroborated by; without it, a lone subtitle is
  // unverifiable rather than a match, which is a different rule doing its job.
  const englishToo = entry('Show.720p.BluRay-EN2', cues.ESiR, 'en', 'en-ok-2');
  const hebrewDoesNot = entry('Show.S01E06.hdtv-LOL', cues['hdtv-LOL'], 'he', 'he-bad');
  const { list } = select(
    [englishWorks, englishToo, hebrewDoesNot],
    classify('Show.1080p.BluRay.x264-AAA'),
    ['en', 'he'],
  );
  // English has something that works, Hebrew does not — so Hebrew keeps its only option.
  expect(list.find((d) => d.entry.id === 'en-ok')?.state).toBe('match');
  expect(list.find((d) => d.entry.id === 'he-bad')).toBeDefined();
});
