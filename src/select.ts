import { type Alignment, align } from './align';
import { type CatalogueEntry, SAME_TIMING } from './catalogue';
import type { Family, Release } from './classify';

export type State = 'match' | 'retimed' | 'mismatch' | 'unknown';

export interface Disposition {
  entry: CatalogueEntry;
  state: State;
  /** Whether the verdict came from comparing timings or only from reading the name. */
  via: 'timing' | 'name';
  /** Present only for `retimed`: how to move this subtitle onto the file's timeline. */
  transform?: Alignment;
  label: string;
}

/** A measured offset smaller than this is not worth calling a correction. */
const ALREADY_ALIGNED_S = 0.35;

const RANK: Record<State, number> = { match: 3, retimed: 2, unknown: 1, mismatch: 0 };

/**
 * Whether anything other than this subtitle's own filename says it belongs to `family`.
 *
 * A lone subtitle claiming a release nothing else claims cannot be checked, and subtitle
 * sites file the occasional entry under the wrong show entirely. Exported because the
 * family counts served to a stream card must apply exactly this rule: the card and the menu
 * disagreeing about the same subtitle is worse than either of them being cautious.
 */
export function isCorroborated(
  entries: CatalogueEntry[],
  entry: CatalogueEntry,
  family: Family,
): boolean {
  return entries.some((o) => o.id !== entry.id && o.cues && o.release.family === family);
}

/**
 * The player already shows the language above each entry, so the label does not repeat it.
 * What it needs to answer, in order: will this work, and if I am choosing between two of
 * them, which release is it.
 */
const describe = (e: CatalogueEntry): string => {
  const family = e.release.family === 'unknown' ? '' : e.release.family;
  const detail = e.release.group ?? e.name.slice(0, 28);
  return [family, detail].filter(Boolean).join(' ');
};

const labelFor = (
  state: State,
  via: 'timing' | 'name',
  entry: CatalogueEntry,
  target: Release,
  transform?: Alignment,
): string => {
  // The verdict comes first, because it is the only part that decides anything. "fits" was
  // measured against a subtitle known to match the file; "likely" was read off a release
  // name and never checked.
  switch (state) {
    case 'match':
      return `${via === 'timing' ? '✅ fits' : '✅ likely'} · ${describe(entry)}`;
    case 'retimed': {
      const shift = transform
        ? ` ${transform.offset >= 0 ? '+' : ''}${transform.offset.toFixed(1)}s`
        : '';
      return `⏱ fixed ${entry.release.family}→${target.family}${shift} · ${describe(entry)}`;
    }
    case 'mismatch':
      return `⚠️ wrong release · ${describe(entry)}`;
    // The source is named only here, where something could not be settled and knowing who
    // supplied it is the next thing anyone would want.
    default:
      return `❔ unchecked · ${describe(entry)} [${entry.source}]`;
  }
};

/**
 * Timing evidence beats the release name whenever both exist.
 *
 * A name is a claim about which release a subtitle was made for; a cue vector is what it
 * actually does. So an entry is compared against the subtitles that really are timed for
 * this file's family, and only falls back to name-matching when a body could not be read.
 * That is also what lets an unlabelled upload be recognised as a perfectly good match.
 */
function decide(
  entry: CatalogueEntry,
  target: Release,
  references: CatalogueEntry[],
  measured: Map<number, Alignment | null>,
): { state: State; via: 'timing' | 'name'; transform?: Alignment } {
  if (entry.cues && references.length > 0) {
    // Subtitles in one cluster share a timeline, so they share an answer. Measuring once
    // per cluster rather than once per subtitle is what keeps a fifty-entry menu quick.
    let best: Alignment | undefined;
    const cluster = entry.cluster;
    if (cluster !== undefined && measured.has(cluster)) {
      best = measured.get(cluster) ?? undefined;
    } else {
      for (const ref of references) {
        if (ref.id === entry.id || !ref.cues) continue;
        if (ref.cluster !== undefined && ref.cluster === cluster) {
          best = { scale: 1, offset: 0, matchPct: 1 };
          break;
        }
        const candidate = align(entry.cues, ref.cues);
        if (!best || candidate.matchPct > best.matchPct) best = candidate;
      }
      if (cluster !== undefined) measured.set(cluster, best ?? null);
    }
    if (best && best.matchPct >= SAME_TIMING) {
      const alreadyThere = best.scale === 1 && Math.abs(best.offset) <= ALREADY_ALIGNED_S;
      return alreadyThere
        ? { state: 'match', via: 'timing' }
        : { state: 'retimed', via: 'timing', transform: best };
    }
    // Measured, and it does not fit. Say so rather than falling back to the name, which
    // would dress a known-bad subtitle up as a good one.
    if (best) return { state: 'mismatch', via: 'timing' };
  }

  // Two unknowns are not a match, they are two unknowns. Saying so is the difference
  // between "this will probably work" and "nobody has checked".
  if (entry.release.family === 'unknown' || target.family === 'unknown') {
    return { state: 'unknown', via: 'name' };
  }
  return { state: entry.release.family === target.family ? 'match' : 'mismatch', via: 'name' };
}

const tieBreak = (a: Disposition, b: Disposition, target: Release): number => {
  const byState = RANK[b.state] - RANK[a.state];
  if (byState !== 0) return byState;

  const groupBonus = (d: Disposition): number =>
    d.entry.release.group && d.entry.release.group === target.group ? 1 : 0;
  const serviceBonus = (d: Disposition): number =>
    d.entry.release.service && d.entry.release.service === target.service ? 1 : 0;
  const resolutionBonus = (d: Disposition): number =>
    d.entry.release.resolution && d.entry.release.resolution === target.resolution ? 1 : 0;

  const score = (d: Disposition): number =>
    groupBonus(d) * 4 + serviceBonus(d) * 2 + resolutionBonus(d) + (d.transform?.matchPct ?? 0);

  return score(b) - score(a);
};

/**
 * Turns a catalogue into what the player should see: every subtitle, labelled with how it
 * relates to the file being played, plus one starred pick per language.
 *
 * Only duplicates are removed. A subtitle that cannot be made to fit is still offered, with
 * a label saying why it may drift - hiding it would leave someone staring at a menu that is
 * missing the only Hebrew subtitle in existence.
 */
export function select(
  entries: CatalogueEntry[],
  target: Release,
  languages: string[],
): { list: Disposition[]; stars: Disposition[] } {
  const served = entries.filter((e) => !e.duplicateOf);
  const references = served.filter(
    (e) => e.cues && e.release.family === target.family && target.family !== 'unknown',
  );

  const measured = new Map<number, Alignment | null>();
  const list: Disposition[] = served.map((entry) => {
    let { state, via, transform } = decide(entry, target, references, measured);

    // A subtitle whose only claim to fit is its own filename, with nothing to check it
    // against, is not a match - it is an assertion. OpenSubtitles files the occasional
    // subtitle under the wrong show, and one such entry was being advertised as the best
    // Russian match for an episode of a series it does not belong to.
    if (state === 'match' && via === 'name' && !isCorroborated(served, entry, target.family)) {
      state = 'unknown';
      transform = undefined;
    }

    return { entry, state, via, transform, label: labelFor(state, via, entry, target, transform) };
  });

  const stars: Disposition[] = [];
  for (const lang of languages) {
    const candidates = list
      .filter((d) => d.entry.lang === lang && (d.state === 'match' || d.state === 'retimed'))
      .sort((a, b) => tieBreak(a, b, target));
    const best = candidates[0];
    if (best) stars.push({ ...best, label: `⭐ best match · ${best.label}` });
  }

  list.sort((a, b) => tieBreak(a, b, target));
  return { list, stars };
}

export type { Family };
