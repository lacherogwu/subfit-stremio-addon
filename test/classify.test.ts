import { expect, test } from 'vitest';
import { classify } from '../src/classify';

test.each([
  ['Prison.Break.S01E06.Riots.Drills.and.the.Devil.Part.1.1080p.DSNP.WEB-DL.DDP5.1.H.264-playWEB.mkv', 'WEB'],
  ['Prison.Break.S01E06.720p.BluRay.x264-HALCYON', 'BluRay'],
  ['Prison.Break.S01E06.720p.BluRay.DTS.x264-ESiR', 'BluRay'],
  ['prison.break.106.hdtv-lol.VO', 'HDTV'],
  ['Prison.Break.S01E6.DVDRIP.SAINTS', 'DVD'],
  ['Prison Break S01E06 - Riots, Drills, and the Devil-1', 'unknown'],
  ['Prison Break (2005)', 'unknown'],
  ['The.Matrix.1999.2160p.UHD.BluRay.REMUX.HDR.HEVC.DTS-HD.MA.5.1-EPSiLON', 'BluRay'],
  ['Shogun.S01E01.1080p.ATVP.WEB-DL.DDP5.1.Atmos.H.264-FLUX', 'WEB'],
])('classifies %s as %s', (name, family) => {
  expect(classify(name).family).toBe(family);
});

test('extracts the streaming service and the group', () => {
  const r = classify('Show.S01E01.1080p.DSNP.WEB-DL.DDP5.1.H.264-playWEB');
  expect(r.service).toBe('DSNP');
  expect(r.group).toBe('playWEB');
  expect(r.resolution).toBe('1080p');
});

test('WEBRip is WEB, and BDRip is BluRay', () => {
  expect(classify('Show.S01E01.1080p.WEBRip.x264-AAA').family).toBe('WEB');
  expect(classify('Show.S01E01.BDRip.x264-BBB').family).toBe('BluRay');
});

test('a WEB release mentioning a disc source is still WEB', () => {
  expect(classify('Show.S01E01.1080p.AMZN.WEB-DL.BDRip.x264-CCC').family).toBe('WEB');
});

test('handles a movie filename with no season or episode', () => {
  const r = classify('Dune.Part.Two.2024.1080p.BluRay.x264-KNiVES.mkv');
  expect(r.family).toBe('BluRay');
  expect(r.group).toBe('KNiVES');
});
