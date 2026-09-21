import { expect, test } from 'vitest';
import { align, applyAlignment } from '../src/align';
import cues from './fixtures/cues.json' with { type: 'json' };

// Every number below is a measurement taken from the real subtitle files on 2026-09-21,
// not a value invented to make the code pass. They are the reason the service exists.

test('two BluRay groups align at scale 1 with a sub-second offset', () => {
  const r = align(cues.ESiR, cues.HALCYON);
  expect(r.scale).toBe(1);
  expect(r.offset).toBeCloseTo(-0.3, 1);
  expect(r.matchPct).toBeGreaterThan(0.85);
});

test('a PAL DVD sub stretches onto BluRay by 25/23.976', () => {
  // The PAL DVD runs fast, so its subtitle must be stretched to fit a 23.976 fps BluRay.
  // The inverse direction is the 0.959 figure quoted in the design.
  const r = align(cues['DVDRIP.SAINTS'], cues.ESiR);
  expect(r.scale).toBeCloseTo(25 / 23.976, 4);
  expect(r.matchPct).toBeGreaterThan(0.95);
});

test('and the BluRay sub compresses onto the DVD by 23.976/25', () => {
  const r = align(cues.ESiR, cues['DVDRIP.SAINTS']);
  expect(r.scale).toBeCloseTo(23.976 / 25, 4);
  expect(r.matchPct).toBeGreaterThan(0.95);
});

test('identical files align perfectly', () => {
  expect(align(cues['hdtv-lol.VO'], cues['hdtv-LOL'])).toMatchObject({ scale: 1, offset: 0 });
  expect(align(cues['hdtv-lol.VO'], cues['hdtv-LOL']).matchPct).toBe(1);
  expect(align(cues.ESiR, cues['Riots,Drills.HALCYON']).matchPct).toBe(1);
});

test('HDTV against BluRay stays below the confidence floor at every ratio', () => {
  // The cut genuinely differs, so no single scale and offset can fix it. Refusing here is
  // what stops the service from confidently serving a subtitle that drifts all episode.
  expect(align(cues['hdtv-LOL'], cues.ESiR).matchPct).toBeLessThan(0.6);
});

test('alignment is symmetric in confidence', () => {
  const forward = align(cues['DVDRIP.SAINTS'], cues.ESiR);
  const back = align(cues.ESiR, cues['DVDRIP.SAINTS']);
  expect(back.matchPct).toBeCloseTo(forward.matchPct, 1);
  expect(back.scale).toBeCloseTo(1 / forward.scale, 3);
});

test('applyAlignment scales and shifts cues', () => {
  const out = applyAlignment([{ start: 100, end: 102, text: 'x' }], {
    scale: 0.95904,
    offset: -0.4,
    matchPct: 1,
  });
  expect(out[0]?.start).toBeCloseTo(100 * 0.95904 - 0.4, 3);
  expect(out[0]?.end).toBeCloseTo(102 * 0.95904 - 0.4, 3);
  expect(out[0]?.text).toBe('x');
});

test('an empty or tiny input is refused rather than guessed at', () => {
  expect(align([], cues.ESiR).matchPct).toBe(0);
  expect(align([1, 2], cues.ESiR).matchPct).toBe(0);
});

test('finds a pure constant offset', () => {
  const shifted = cues.ESiR.map((t) => t + 12.5);
  const r = align(cues.ESiR, shifted);
  expect(r.scale).toBe(1);
  expect(r.offset).toBeCloseTo(12.5, 1);
  expect(r.matchPct).toBe(1);
});
