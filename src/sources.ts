import type { Config } from './config';

export interface RawSub {
  /** Stable within a source; combined with the source it identifies a subtitle for us. */
  id: string;
  /** The configured name of the addon that supplied it. */
  source: string;
  /** Two-letter code. */
  lang: string;
  /** The release the subtitle was timed for, as the upstream states it. */
  name: string;
  url: string;
}

interface UpstreamSub {
  id?: unknown;
  url?: unknown;
  lang?: unknown;
}

/**
 * Upstreams label subtitles with a prefix that is useful to a human reading a menu and
 * noise to a matcher. The release name is what carries the timing information, so it is
 * extracted here and the decoration is rebuilt later, with what we know added to it.
 */
const stripPrefix = (id: string): string => {
  const bracketed = /^\[[A-Z0-9+]+\]\s*(.+)$/.exec(id);
  if (bracketed?.[1]) return bracketed[1];
  // OpenSubtitles V3+ ids look like "v3+|4920953|Release.Name".
  const piped = id.split('|');
  if (piped.length >= 3) return piped.slice(2).join('|');
  return id;
};

/** ISO 639-2 is what the addons speak; everything downstream speaks two-letter codes. */
const LANGS: Record<string, string> = {
  heb: 'he',
  he: 'he',
  eng: 'en',
  en: 'en',
  rus: 'ru',
  ru: 'ru',
};

const normaliseLang = (lang: string): string => LANGS[lang.toLowerCase()] ?? lang.toLowerCase();

const buildUrl = (base: string, type: string, id: string, extras: string): string => {
  const root = base.replace(/\/$/, '');
  const tail = extras ? `/${extras}` : '';
  return `${root}/subtitles/${type}/${id}${tail}.json`;
};

async function fetchOne(
  source: string,
  base: string,
  type: string,
  id: string,
  extras: string,
  languages: string[],
  signal?: AbortSignal,
): Promise<RawSub[]> {
  const res = await fetch(buildUrl(base, type, id, extras), {
    signal: signal ?? null,
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const body = (await res.json()) as { subtitles?: UpstreamSub[] };
  const subs = Array.isArray(body.subtitles) ? body.subtitles : [];

  const out: RawSub[] = [];
  for (const s of subs) {
    if (typeof s.url !== 'string' || typeof s.id !== 'string') continue;
    const lang = normaliseLang(typeof s.lang === 'string' ? s.lang : '');
    if (!languages.includes(lang)) continue;
    out.push({ id: `${source}:${s.id}`, source, lang, name: stripPrefix(s.id), url: s.url });
  }
  return out;
}

/**
 * Asks every upstream at once and keeps whatever answers. A source that fails becomes a
 * message, never an exception and never a silently shorter list: the operator's stated
 * preference is to see a dead source labelled rather than to wonder where it went.
 */
export async function fetchAll(
  cfg: Config,
  type: string,
  id: string,
  extras: string,
  signal?: AbortSignal,
): Promise<{ subs: RawSub[]; errors: string[] }> {
  const results = await Promise.allSettled(
    cfg.sources.map((s) => fetchOne(s.name, s.url, type, id, extras, cfg.languages, signal)),
  );

  const subs: RawSub[] = [];
  const errors: string[] = [];
  results.forEach((result, i) => {
    const name = cfg.sources[i]?.name ?? 'unknown';
    if (result.status === 'fulfilled') subs.push(...result.value);
    else {
      const reason = result.reason;
      const message =
        reason instanceof Error && (reason.name === 'TimeoutError' || reason.name === 'AbortError')
          ? 'took too long, skipped'
          : reason instanceof Error
            ? reason.message
            : String(reason);
      errors.push(`${name}: ${message}`);
    }
  });

  return { subs, errors };
}
