import type { Cue } from './subtitle';

export interface Alignment {
  /** Multiplier applied to the source timeline, almost always an fps ratio. */
  scale: number;
  /** Seconds added after scaling. */
  offset: number;
  /** Fraction of the source's cues that land on a target cue, 0 to 1. */
  matchPct: number;
}

/**
 * Subtitles drift between releases for exactly two reasons: a different frame rate, and a
 * different starting point. The frame-rate cases are a short, known list - PAL 25 against
 * NTSC 23.976 is the one that shows up constantly in older subtitles - so searching that
 * list beats fitting an arbitrary scale, which would happily find a meaningless best fit
 * for two subtitles that have nothing to do with each other.
 */
export const FPS_RATIOS: number[] = [
  1,
  25 / 23.976,
  23.976 / 25,
  24 / 23.976,
  23.976 / 24,
  25 / 24,
  24 / 25,
  30 / 29.97,
  29.97 / 30,
];

/** A cue counts as matched when it lands this close to a target cue. */
const TOLERANCE_S = 0.35;
/** Offsets are proposed by voting in bins this wide, then counted exactly. */
const BIN_S = 0.1;
/** Below this many cues there is not enough signal to tell alignment from coincidence. */
export const MIN_CUES = 5;
/** Offsets beyond this are not a subtitle for the same content. */
const MAX_OFFSET_S = 600;
/** How many of the most-voted offsets to score exactly, per ratio. */
const CANDIDATES = 6;
/**
 * Offsets are *proposed* from a sample of the source cues and then *scored* against all of
 * them. A true offset is shared by hundreds of cues, so a few dozen are more than enough to
 * nominate it, and the expensive all-pairs pass shrinks by an order of magnitude without
 * changing any answer.
 */
const VOTERS = 60;
/** A fit this good ends the search: no other frame-rate ratio can improve on it. */
const DECISIVE = 0.98;

/**
 * Byte-identical timing, which is what a re-upload of the same file looks like. Checked
 * directly rather than through `align`, because it is the most common relationship in a
 * subtitle menu and answering it costs one pass instead of nine.
 */
export function identicalTiming(a: number[], b: number[], tolerance = 0.05): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs((a[i] as number) - (b[i] as number)) > tolerance) return false;
  }
  return true;
}

const nearestWithin = (sorted: number[], value: number, tolerance: number): boolean => {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = sorted[mid] as number;
    if (Math.abs(v - value) <= tolerance) return true;
    if (v < value) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
};

/**
 * Finds the (scale, offset) that best maps `a`'s cue starts onto `b`'s.
 *
 * Two passes per candidate ratio: propose offsets by histogramming every pairwise
 * difference into 100 ms bins - the true offset wins by a landslide when one exists - then
 * score the best few exactly. The score is deliberately a *fraction of cues matched* rather
 * than a least-squares error, because the question being answered is "do these two describe
 * the same speech?", and a fraction says no in a way an error metric never quite does.
 */
export function align(a: number[], b: number[]): Alignment {
  const none: Alignment = { scale: 1, offset: 0, matchPct: 0 };
  if (a.length < MIN_CUES || b.length < MIN_CUES) return none;

  const target = [...b].sort((x, y) => x - y);
  const denominator = Math.min(a.length, b.length);
  let best = none;

  for (const scale of FPS_RATIOS) {
    // Same-frame-rate pairs are the overwhelming majority, and a near-perfect fit at ratio
    // 1 cannot be beaten by another ratio. Stopping there turns the common case into one
    // pass instead of nine.
    if (best.matchPct >= DECISIVE) break;
    const scaled = a.map((t) => t * scale);
    const step = Math.max(1, Math.ceil(scaled.length / VOTERS));
    const voters = scaled.filter((_, i) => i % step === 0);

    const votes = new Map<number, number>();
    for (const x of voters) {
      for (const y of target) {
        const d = y - x;
        if (d < -MAX_OFFSET_S || d > MAX_OFFSET_S) continue;
        const bin = Math.round(d / BIN_S);
        votes.set(bin, (votes.get(bin) ?? 0) + 1);
      }
    }
    if (votes.size === 0) continue;

    const candidates = [...votes.entries()]
      .sort((p, q) => q[1] - p[1])
      .slice(0, CANDIDATES)
      .map(([bin]) => bin * BIN_S);

    for (const offset of candidates) {
      // The bin's own vote count is an upper bound on how many cues this offset can match,
      // and it is already known - skip the exact pass when it cannot beat the best so far.
      let matched = 0;
      for (const x of scaled) {
        if (nearestWithin(target, x + offset, TOLERANCE_S)) matched++;
      }
      const matchPct = matched / denominator;
      if (matchPct > best.matchPct) {
        best = { scale, offset: Number(offset.toFixed(3)), matchPct };
      }
    }
  }

  // A ratio of exactly 1 with a zero offset is the common case; report it cleanly so
  // callers can compare against it without worrying about floating-point dust.
  if (best.matchPct > 0 && Math.abs(best.offset) < 1e-9) best = { ...best, offset: 0 };
  return best;
}

export function applyAlignment(cues: Cue[], a: Alignment): Cue[] {
  return cues.map((c) => ({
    start: c.start * a.scale + a.offset,
    end: c.end * a.scale + a.offset,
    text: c.text,
  }));
}
