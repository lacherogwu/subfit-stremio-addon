import { createHash, timingSafeEqual } from 'node:crypto';
import { type Context, Hono } from 'hono';
import { applyAlignment } from './align';
import type { Cache } from './cache';
import { buildCatalogue, type CatalogueDeps, type CatalogueEntry } from './catalogue';
import { classify } from './classify';
import type { Config } from './config';
import { type Disposition, select } from './select';
import { parseSubtitle, toSrt, unzipFirstSubtitle } from './subtitle';
import { VERSION } from './version';

export interface AppDeps extends CatalogueDeps {
  cfg: Config;
  cache: Cache;
  log: (...args: unknown[]) => void;
}

interface Ref {
  url: string;
  entryId: string;
  scale: number;
  offset: number;
  /** The catalogue this came from, so a stand-in can be found if the file is unavailable. */
  catalogue?: string;
}

/**
 * A *fresh* object per response, deliberately.
 *
 * `@hono/node-server` writes `Content-Length` into whatever header object it is handed, as
 * a number. Hand it the same object twice and the second response finds a non-string header
 * value, tries to iterate it, and dies with "v is not iterable" - a 500 on every request
 * after the first. Unit tests cannot see this: `app.request()` never goes through the node
 * adapter, so nothing mutates anything.
 */
/**
 * Players key subtitles by `id` and quietly drop repeats, so two subtitles that happen to
 * describe themselves the same way - the same release, from two sites - would cost one of
 * them its place in the menu. Twelve Hebrew subtitles were arriving as eight.
 *
 * The source distinguishes them, and a counter covers the rest.
 */
function unique(subtitles: { id: string; url: string; lang: string }[]): typeof subtitles {
  const seen = new Map<string, number>();
  return subtitles.map((s) => {
    const count = seen.get(s.id) ?? 0;
    seen.set(s.id, count + 1);
    if (count === 0) return s;
    return { ...s, id: `${s.id} (${count + 1})` };
  });
}

const srtHeaders = (): Record<string, string> => ({
  'content-type': 'text/plain; charset=utf-8',
});

const sameToken = (given: string, expected: string): boolean => {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

const refKey = (entryId: string, scale: number, offset: number): string =>
  createHash('sha1').update(`${entryId}|${scale}|${offset}`).digest('hex').slice(0, 16);

/**
 * Stremio sends extras as one path segment of `key=value` pairs. Only three matter here,
 * and `filename` is the important one: it is the only description of what is actually
 * playing, and therefore the only thing that can say which subtitle belongs to it.
 */
export function parseExtras(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const pair of decodeURIComponent(raw).split('&')) {
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    out[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return out;
}

export function createApp(deps: AppDeps): Hono {
  const { cfg, cache, log } = deps;
  const app = new Hono();

  app.use('/:token/*', async (c, next) => {
    if (!sameToken(c.req.param('token') ?? '', cfg.token)) return c.text('forbidden', 403);
    await next();
  });

  app.get('/:token/manifest.json', (c) =>
    c.json({
      id: 'com.github.subfit',
      version: VERSION,
      name: 'subfit',
      description:
        'Subtitles labelled with the release they were timed for, deduplicated, and re-timed to the file being played.',
      resources: ['subtitles'],
      types: ['series', 'movie'],
      catalogs: [],
    }),
  );

  const serveList = async (
    c: Context,
    type: string,
    id: string,
    extras: string,
  ): Promise<Response> => {
    const target = classify(parseExtras(extras).filename ?? '');

    // The finished menu is cached per file family, not just the catalogue it was built
    // from: turning a catalogue into a labelled, ranked list means measuring every subtitle
    // against the ones that fit, and that work was being redone on every request.
    // The version is part of the key: a cached menu is a rendering, and an upgrade that
    // changes how entries are labelled must not leave hours of old wording on the screen.
    const responseKey = `resp:${VERSION}:${type}:${id}:${target.family}`;
    const ready = cache.getCatalogue<{ subtitles: unknown[] }>(responseKey);
    if (ready) {
      log(`subtitles ${type}/${id} target=${target.family} → cached`);
      return c.json(ready);
    }

    const { entries, errors } = await buildCatalogue(deps, cfg, type, id, extras, {
      targetFamily: target.family,
    });
    const { list, stars } = select(entries, target, cfg.languages);

    const origin = cfg.baseUrl || new URL(c.req.url).origin;

    const toStremio = (d: Disposition): { id: string; url: string; lang: string } => {
      const scale = d.transform?.scale ?? 1;
      const offset = d.transform?.offset ?? 0;
      const key = refKey(d.entry.id, scale, offset);
      cache.putRef(key, {
        url: d.entry.url,
        entryId: d.entry.id,
        scale,
        offset,
        catalogue: `${type}:${id}`,
      } satisfies Ref);
      return {
        // The label names the source itself, and only where something could not be
        // settled - appending it again here tagged every entry twice.
        id: d.label,
        url: `${origin}/${cfg.token}/sub/${key}.srt`,
        lang: d.entry.lang,
      };
    };

    const subtitles = unique([...stars.map(toStremio), ...list.map(toStremio)]);

    // A dead upstream is shown, not swallowed: an entry nobody can select, whose title says
    // which source failed. An empty list would look like "no subtitles exist".
    for (const message of errors) {
      subtitles.push({
        id: `❌ ${message}`,
        url: `${origin}/${cfg.token}/sub/none.srt`,
        lang: cfg.languages[0] ?? 'en',
      });
    }

    log(`subtitles ${type}/${id} target=${target.family} → ${subtitles.length} entries`);
    // Only a menu built from a complete catalogue is worth keeping; one assembled while an
    // upstream was failing would otherwise be served for hours.
    if (errors.length === 0 && subtitles.length > 0) cache.putCatalogue(responseKey, { subtitles });
    return c.json({ subtitles });
  };

  app.get('/:token/subtitles/:type/:id/:extras', (c) =>
    serveList(
      c,
      c.req.param('type'),
      c.req.param('id'),
      (c.req.param('extras') ?? '').replace(/\.json$/, ''),
    ),
  );

  app.get('/:token/subtitles/:type/:id', (c) =>
    serveList(c, c.req.param('type'), (c.req.param('id') ?? '').replace(/\.json$/, ''), ''),
  );

  app.get('/:token/sub/:file', async (c) => {
    const key = (c.req.param('file') ?? '').replace(/\.srt$/, '');
    const ref = cache.getRef<Ref>(key);
    if (!ref) return c.text('unknown subtitle', 404);

    const cached = cache.getRetimed(key);
    if (cached) return c.body(new Uint8Array(cached), 200, srtHeaders());

    let body = cache.getBody(ref.entryId);
    if (!body) {
      try {
        body = unzipFirstSubtitle(await deps.fetchBody(ref.url));
      } catch (err) {
        // The subtitle site is down for this file. Subtitles with identical timings were
        // already identified when the catalogue was built, so one of those can stand in:
        // the same timeline, a different server. Better a stand-in than nothing, which is
        // what a player does with a failed subtitle - it simply shows none.
        body = await standIn(ref, key, String(err));
        if (!body) return c.text('subtitle could not be fetched', 502);
      }
    }

    const cues = parseSubtitle(body);
    const moved =
      ref.scale === 1 && ref.offset === 0
        ? cues
        : applyAlignment(cues, { scale: ref.scale, offset: ref.offset, matchPct: 1 });
    const out = Buffer.from(toSrt(moved), 'utf8');
    cache.putRetimed(key, out);

    return c.body(new Uint8Array(out), 200, srtHeaders());
  });

  /**
   * A subtitle with the same timings from somewhere else, for when the chosen one's server
   * will not serve it. Restricted to the same language, since the point is to be readable,
   * and to the same cluster, since the point is to still be in sync.
   */
  const standIn = async (ref: Ref, key: string, why: string): Promise<Buffer | null> => {
    const entries = ref.catalogue ? cache.getCatalogue<CatalogueEntry[]>(ref.catalogue) : null;
    const original = entries?.find((e) => e.id === ref.entryId);
    if (!entries || !original) {
      log(`sub ${key}: upstream fetch failed: ${why}`);
      return null;
    }

    const alternates = entries.filter(
      (e) =>
        e.id !== original.id &&
        e.lang === original.lang &&
        (e.duplicateOf === original.id ||
          original.duplicateOf === e.id ||
          (e.duplicateOf !== undefined && e.duplicateOf === original.duplicateOf) ||
          (e.cluster !== undefined && e.cluster === original.cluster)),
    );

    for (const alternate of alternates) {
      const cached = cache.getBody(alternate.id);
      if (cached) {
        log(`sub ${key}: ${why}; served an identical subtitle from ${alternate.source}`);
        return cached;
      }
      try {
        const fetched = unzipFirstSubtitle(await deps.fetchBody(alternate.url));
        log(`sub ${key}: ${why}; served an identical subtitle from ${alternate.source}`);
        return fetched;
      } catch {
        // Try the next one.
      }
    }

    log(`sub ${key}: upstream fetch failed: ${why}; no stand-in available`);
    return null;
  };

  return app;
}
