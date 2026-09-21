import { createHash, timingSafeEqual } from 'node:crypto';
import { type Context, Hono } from 'hono';
import { applyAlignment } from './align';
import type { Cache } from './cache';
import { buildCatalogue, type CatalogueDeps } from './catalogue';
import { classify, type Family } from './classify';
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
const srtHeaders = (): Record<string, string> => ({
  'content-type': 'text/plain; charset=utf-8',
});

/** The family lookup answers a stream list, so it must never be the slow part of one. */
const FAMILIES_BUDGET_MS = 1000;
/**
 * The warm-up that the family lookup kicks off has nobody waiting on it, and it runs while
 * someone is still reading a list of streams. It can afford to wait out a slow upstream.
 */
const BACKGROUND_BUDGET_MS = 60_000;

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
    const { entries, errors } = await buildCatalogue(deps, cfg, type, id, extras, {
      targetFamily: target.family,
    });
    const { list, stars } = select(entries, target, cfg.languages);

    const origin = cfg.baseUrl || new URL(c.req.url).origin;

    const toStremio = (d: Disposition): { id: string; url: string; lang: string } => {
      const scale = d.transform?.scale ?? 1;
      const offset = d.transform?.offset ?? 0;
      const key = refKey(d.entry.id, scale, offset);
      cache.putRef(key, { url: d.entry.url, entryId: d.entry.id, scale, offset } satisfies Ref);
      return {
        id: `${d.label} [${d.entry.source}]`,
        url: `${origin}/${cfg.token}/sub/${key}.srt`,
        lang: d.entry.lang,
      };
    };

    const subtitles = [...stars.map(toStremio), ...list.map(toStremio)];

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
        log(`sub ${key}: upstream fetch failed: ${String(err)}`);
        return c.text('subtitle could not be fetched', 502);
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
   * Which timing families exist for a title, per language. Read by the stream list, so it
   * answers from cache or gives up: a subtitle lookup must never hold up a list of streams.
   */
  app.get('/:token/families/:type/:id', async (c) => {
    const type = c.req.param('type');
    const id = (c.req.param('id') ?? '').replace(/\.json$/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FAMILIES_BUDGET_MS);
    try {
      // Names alone are enough to say which families exist, and they cost one round trip.
      // The full measured catalogue is built in the background, so it is usually already
      // warm by the time someone presses play on one of the streams this list just tagged.
      const { entries } = await buildCatalogue(deps, cfg, type, id, '', {
        signal: controller.signal,
        namesOnly: true,
      });
      void buildCatalogue(deps, cfg, type, id, '', { deadlineMs: BACKGROUND_BUDGET_MS }).catch(
        () => {},
      );
      const counts: Record<string, Partial<Record<Family, number>>> = {};
      for (const e of entries) {
        if (e.duplicateOf) continue;
        const perLang = counts[e.lang] ?? {};
        counts[e.lang] = perLang;
        perLang[e.release.family] = (perLang[e.release.family] ?? 0) + 1;
      }
      return c.json(counts);
    } catch {
      return c.json({});
    } finally {
      clearTimeout(timer);
    }
  });

  return app;
}
