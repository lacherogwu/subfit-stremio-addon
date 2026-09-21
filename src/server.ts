// subfit: subtitles labelled with the release they were timed for, deduplicated, and
// re-timed to the file actually playing.
import { copyFileSync, statSync, truncateSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { Cache } from './cache';
import { CONFIG_DIR, loadConfig } from './config';
import { createApp } from './routes';
import { fetchAll } from './sources';
import { VERSION } from './version';

const log = (...args: unknown[]): void => console.log(new Date().toISOString(), ...args);

const cfg = loadConfig();
for (const issue of cfg.configIssues) log(`! ${issue}`);

const cache = new Cache(CONFIG_DIR);
cache.sweep();

const HOUR = 3600_000;
const MAX_LOG_BYTES = 5 * 1024 * 1024;

/**
 * Truncates the same file the supervisor writes to. Rotating a *different* path leaves the
 * real log growing without limit while an empty one is dutifully rotated - a failure this
 * project has already shipped once, in another service.
 */
const rotateLog = (): void => {
  if (!cfg.logFile) return;
  try {
    if (statSync(cfg.logFile).size < MAX_LOG_BYTES) return;
    copyFileSync(cfg.logFile, `${cfg.logFile}.1`);
    truncateSync(cfg.logFile, 0);
    log('rotated log');
  } catch {
    // A missing log file is normal before the first write.
  }
};

setInterval(() => {
  cache.sweep();
  rotateLog();
}, 6 * HOUR).unref();

const fetchBody = async (url: string, signal?: AbortSignal): Promise<Buffer> => {
  const res = await fetch(url, { signal: signal ?? null });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};

const app = createApp({ cfg, cache, log, fetchAll, fetchBody });

serve({ fetch: app.fetch, port: cfg.port, hostname: '0.0.0.0' }, (info) => {
  log(`subfit v${VERSION} listening on :${info.port}`);
  log(`languages: ${cfg.languages.join(', ')}; deadline ${cfg.deadlineMs} ms`);
  log(`manifest: http://<host>:${info.port}/<token>/manifest.json`);
});
