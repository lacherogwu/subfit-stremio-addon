import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

export const CONFIG_DIR: string = process.env.SUBFIT_DIR || join(homedir(), '.config', 'subfit');

export interface Sources {
  wizdom: string;
  ktuvit: string;
  opensubtitles: string;
}

export interface Config {
  port: number;
  token: string;
  logFile: string;
  /**
   * Upstream addons, wrapped over the Stremio protocol rather than scraped, so no
   * credentials are ever needed. These are defaults, not constants: anyone self-hosting
   * their own instance of an upstream should be able to point at it without editing source.
   */
  sources: Sources;
  /**
   * Public address this service is reached at, if it differs from the address a caller
   * used. Subtitle URLs are handed to a *player*, which may be a television on the other
   * side of the house, while the caller may be an aggregator on this very machine - so
   * URLs built from the incoming request would point at 127.0.0.1 and fetch nothing.
   * Empty means "use the address the request came in on", which is right when the player
   * calls this service directly.
   */
  baseUrl: string;

  /** Languages to serve, in preference order. Each gets its own best-match entry. */
  languages: string[];
  /**
   * The whole budget for answering a subtitle list: upstream lists and subtitle bodies
   * together. Whatever has not arrived by then is answered without - names are classified
   * for free, and bodies only buy dedupe and re-timing. Staying inside the player's own
   * timeout matters more than measuring every last entry, and the background warm-up will
   * finish the job before the next request anyway.
   */
  deadlineMs: number;
  /** Fields that failed validation and fell back to their default, one message each. */
  configIssues: string[];
}

const DEFAULTS: Omit<Config, 'token' | 'configIssues' | 'logFile'> = {
  port: 18702,
  baseUrl: '',
  sources: {
    wizdom: 'https://4b139a4b7f94-wizdom-stremio-v2.baby-beamup.club',
    ktuvit: 'https://4b139a4b7f94-ktuvit-stremio.baby-beamup.club',
    opensubtitles:
      'https://opensubtitles.stremio.homes/en%7Che%7Cru/ai-translated=false%7Cfrom=all',
  },
  languages: ['en', 'he', 'ru'],
  deadlineMs: 9000,
};

const SourcesSchema = z.object({
  wizdom: z.string().url(),
  ktuvit: z.string().url(),
  opensubtitles: z.string().url(),
});

const Schema = z.object({
  port: z.number().int().min(1).max(65535),
  baseUrl: z.string(),
  token: z.string().min(16),
  logFile: z.string().min(1),
  sources: SourcesSchema,
  languages: z.array(z.string().min(2)).min(1),
  deadlineMs: z.number().int().min(500).max(30000),
});

/**
 * Validates field by field rather than all-or-nothing. One bad key in a hand-edited file
 * should cost that key's value, not the whole configuration - and the operator should be
 * told which key it was, since the alternative is a service that silently runs on defaults.
 */
export function loadConfig(dir: string = CONFIG_DIR): Config {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'config.json');

  let raw: Record<string, unknown> = {};
  const issues: string[] = [];
  if (existsSync(file)) {
    try {
      raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch (err) {
      issues.push(`config.json is not valid JSON (${String(err)}); using defaults`);
    }
  }

  const defaults: Omit<Config, 'configIssues'> = {
    ...DEFAULTS,
    token:
      typeof raw.token === 'string' && raw.token.length >= 16
        ? raw.token
        : randomBytes(16).toString('hex'),
    logFile: join(dir, 'subfit.log'),
  };

  const cfg: Omit<Config, 'configIssues'> = { ...defaults };
  for (const key of Object.keys(Schema.shape) as (keyof typeof Schema.shape)[]) {
    if (!(key in raw)) continue;
    const parsed = Schema.shape[key].safeParse(raw[key]);
    if (parsed.success) {
      // Each key is validated by its own schema above, so the value matches this key's type.
      (cfg as Record<string, unknown>)[key] = parsed.data;
    } else {
      issues.push(
        `config.json: ${key} is invalid (${parsed.error.issues[0]?.message ?? 'bad value'}); using the default`,
      );
    }
  }

  // Write back so the file always shows every key the service understands, and so the
  // generated token survives a restart.
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`);
  renameSync(tmp, file);

  return { ...cfg, configIssues: issues };
}
