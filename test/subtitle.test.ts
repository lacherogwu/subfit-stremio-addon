import { zipSync } from 'fflate';
import { expect, test } from 'vitest';
import { decodeText, parseSubtitle, toSrt, unzipFirstSubtitle } from '../src/subtitle';

test('parses SRT into cues in seconds', () => {
  const srt = Buffer.from('1\n00:00:01,500 --> 00:00:03,000\nשלום\n\n', 'utf8');
  expect(parseSubtitle(srt)).toEqual([{ start: 1.5, end: 3, text: 'שלום' }]);
});

test('decodes CP1255 Hebrew without mojibake', () => {
  const cp1255 = Buffer.from([0xf9, 0xec, 0xe5, 0xed]);
  expect(decodeText(cp1255)).toBe('שלום');
});

test('keeps valid UTF-8 Hebrew as it is', () => {
  expect(decodeText(Buffer.from('שלום', 'utf8'))).toBe('שלום');
});

test('parses WebVTT with a header and dotted milliseconds', () => {
  const vtt = Buffer.from('WEBVTT\n\n00:00:02.250 --> 00:00:04.000\nhi\n', 'utf8');
  expect(parseSubtitle(vtt)[0]?.start).toBeCloseTo(2.25, 3);
});

test('keeps multi-line cue text together', () => {
  const srt = Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nline one\nline two\n\n', 'utf8');
  expect(parseSubtitle(srt)[0]?.text).toBe('line one\nline two');
});

test('round-trips cues through toSrt', () => {
  const srt = toSrt([{ start: 61.25, end: 63, text: 'a' }]);
  expect(srt).toContain('00:01:01,250 --> 00:01:03,000');
  expect(parseSubtitle(Buffer.from(srt, 'utf8'))).toEqual([{ start: 61.25, end: 63, text: 'a' }]);
});

test('pulls the subtitle out of a zip, which is how wizdom serves them', () => {
  const zip = Buffer.from(zipSync({ 'readme.txt': new Uint8Array([1]), 'sub.srt': new Uint8Array([0x41]) }));
  expect(unzipFirstSubtitle(zip)).toEqual(Buffer.from([0x41]));
});

test('passes a plain subtitle through unzipFirstSubtitle untouched', () => {
  const plain = Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nx\n', 'utf8');
  expect(unzipFirstSubtitle(plain)).toEqual(plain);
});
