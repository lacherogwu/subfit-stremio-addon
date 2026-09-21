import { align, identicalTiming } from './align';
import type { Cache } from './cache';
import { classify, type Release } from './classify';
import type { Config } from './config';
import type { RawSub, fetchAll as realFetchAll, SourceName } from './sources';
import { parseSubtitle, unzipFirstSubtitle } from './subtitle';

export interface CatalogueEntry {
  id: string;
  source: SourceName;
  lang: string;
  name: string;
  url: string;
  release: Release;
  /** Cue starts, downsampled. Absent when the body could not be read. */
  cues?: number[];
  /** Entries that share a timing, whether or not they share a release name. */
  cluster?: number;
  /** Set when another entry has byte-identical timing; the twin's id. */
  duplicateOf?: string;
}

export interface CatalogueDeps {
  cache: Cache;
  fetchAll: typeof realFetchAll;
  fetchBody: (url: string, signal?: AbortSignal) => Promise<Buffer>;
}

/**
 * Two subtitles count as the same file when nearly every cue lands on a cue of the other
 * with no shift at all. Wizdom alone served two such pairs for one episode.
 */
const DUPLICATE = 0.98;

/**
 * And two subtitles count as the same *timing* well below that. The measurements this
 * service was built from put same-family pairs at ~0.90 and cross-family pairs at ~0.37,
 * so the threshold belongs in the empty middle of that gap rather than at the edge of the
 * good case: a 0.90 cut would have rejected the very pair that proved families are real.
 */
const SAME_TIMING = 0.7;

/** A shift smaller than this is imperceptible, so it does not split a cluster. */
const IN_SYNC_S = 0.35;

/**
 * A safety valve, not an optimisation. Two subtitles are compared cue by cue, and sampling
 * them independently picks non-corresponding points - 380 cues thinned to 200 no longer
 * lines up with 388 cues thinned to 200, and a pair that genuinely matches at 90% scores
 * far below it. So the cap sits well above any real subtitle and only guards against a
 * pathological file.
 */
const SAMPLE = 2000;

const downsample = (values: number[], limit = SAMPLE): number[] => {
  if (values.length <= limit) return values;
  const step = values.length / limit;
  const out: number[] = [];
  for (let i = 0; i < limit; i++) out.push(values[Math.floor(i * step)] as number);
  return out;
};

const withConcurrency = async <T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> => {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      if (item !== undefined) await worker(item);
    }
  });
  await Promise.all(runners);
};

/**
 * Fetches every subtitle's timings, then works out which are the same file, which share a
 * timeline, and which stand alone.
 *
 * Bodies are fetched under a deadline rather than to completion. A subtitle whose body does
 * not arrive keeps its entry and its name-based classification - it is offered, labelled
 * with what is known - because an incomplete menu is a worse failure than an unverified
 * label, and the operator asked to see problems rather than have them hidden.
 */
export interface CatalogueOptions {
  signal?: AbortSignal;
  /**
   * Skip the bodies: classify from names alone, and do not cache the result. Used by the
   * family lookup, which answers a stream list and must be quick, and which must never
   * leave a half-measured catalogue behind for the subtitle list to find.
   */
  namesOnly?: boolean;
  /** The release being played, when known: its family's subtitles are fetched first. */
  targetFamily?: string;
  /** Overrides the interactive budget. The background warm-up uses a generous one. */
  deadlineMs?: number;
}

export async function buildCatalogue(
  deps: CatalogueDeps,
  cfg: Config,
  type: string,
  id: string,
  extras: string,
  opts: CatalogueOptions = {},
): Promise<{ entries: CatalogueEntry[]; errors: string[] }> {
  const { signal, namesOnly, targetFamily } = opts;
  const key = `${type}:${id}`;
  const cached = deps.cache.getCatalogue<CatalogueEntry[]>(key);
  if (cached) return { entries: cached, errors: [] };

  // One budget for the whole request, spent on whatever needs it. The upstreams are not
  // equally quick - one of them has been measured at anything from 3 to 11 seconds for the
  // same list - so a budget that covered only the bodies would still let a slow list hold
  // up a player that is waiting to show a menu.
  const budget = AbortSignal.timeout(opts.deadlineMs ?? cfg.deadlineMs);

  // The lists are cached separately from the measured catalogue. A request truncated by
  // the budget would otherwise pay the slowest upstream's list again on the very next try,
  // which is the one case where being slow twice is unforgivable.
  const listKey = `list:${key}`;
  const cachedList = deps.cache.getCatalogue<RawSub[]>(listKey);
  const fetched = cachedList
    ? { subs: cachedList, errors: [] as string[] }
    : await deps.fetchAll(cfg, type, id, extras, signal ?? budget);
  const { subs, errors } = fetched;
  if (!cachedList && errors.length === 0 && subs.length > 0) {
    deps.cache.putCatalogue(listKey, subs);
  }
  if (subs.length === 0) return { entries: [], errors };

  const entries: CatalogueEntry[] = subs.map((s: RawSub) => ({
    id: s.id,
    source: s.source,
    lang: s.lang,
    name: s.name,
    url: s.url,
    release: classify(s.name),
  }));

  if (namesOnly) return { entries, errors };

  // The subtitles that can answer "does this fit?" are the ones timed for the file being
  // played, so they are fetched first. If the deadline bites, it bites the entries whose
  // bodies would have changed the answer least.
  const ordered = targetFamily
    ? [...entries].sort(
        (a, b) =>
          Number(b.release.family === targetFamily) - Number(a.release.family === targetFamily),
      )
    : entries;

  await withConcurrency(ordered, 16, async (entry) => {
    if (budget.aborted) return;
    const known = deps.cache.getCues(entry.id);
    if (known) {
      entry.cues = known;
      return;
    }
    try {
      const raw = await deps.fetchBody(entry.url, signal ?? budget);
      const body = unzipFirstSubtitle(raw);
      const starts = downsample(parseSubtitle(body).map((c) => c.start));
      if (starts.length > 0) {
        entry.cues = starts;
        deps.cache.putBody(entry.id, body, starts);
      }
    } catch {
      // Left cueless on purpose: it is still served, just without a verified timing.
    }
  });

  markDuplicates(entries);
  assignClusters(entries);

  // Only a complete catalogue is worth keeping for six hours. One truncated by the budget
  // is fine to answer with now and wrong to hand to every later request, so it is left
  // uncached and the background warm-up gets another go at it.
  if (!budget.aborted && errors.length === 0) deps.cache.putCatalogue(key, entries);

  return { entries, errors };
}

function markDuplicates(entries: CatalogueEntry[]): void {
  const timed = entries.filter((e) => e.cues);
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length; j++) {
      const a = timed[i] as CatalogueEntry;
      const b = timed[j] as CatalogueEntry;
      if (b.duplicateOf || a.duplicateOf) continue;
      if (identicalTiming(a.cues as number[], b.cues as number[])) b.duplicateOf = a.id;
    }
  }
}

/**
 * Groups subtitles that play in sync with each other *as they are*.
 *
 * The "as they are" is load-bearing. A PAL DVD subtitle matches a BluRay one at 99.5% once
 * it is stretched, but it does not play in sync with it, and a cluster that conflated the
 * two would let a subtitle needing a correction be served without one. So a shared cluster
 * requires ratio 1 and no meaningful shift; anything reachable only through a transform is
 * a different cluster, related by a measurement rather than by identity.
 *
 * Only one representative per cluster is ever compared again, so twenty subtitles cost a
 * handful of alignments rather than one per pair.
 */
function assignClusters(entries: CatalogueEntry[]): void {
  const timed = entries.filter((e) => e.cues);
  const representatives: CatalogueEntry[] = [];

  for (const entry of timed) {
    const found = representatives.findIndex((rep) => {
      const r = align(entry.cues as number[], rep.cues as number[]);
      return r.matchPct >= SAME_TIMING && r.scale === 1 && Math.abs(r.offset) <= IN_SYNC_S;
    });
    if (found === -1) {
      entry.cluster = representatives.length;
      representatives.push(entry);
    } else {
      entry.cluster = found;
    }
  }
}

export { DUPLICATE, SAME_TIMING };
