import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/**
 * A catalogue goes stale because uploaders add subtitles; a subtitle body never changes
 * once published, and neither does a re-timing derived from it. Hence the gap between the
 * two lifetimes - it is what makes the second view of an episode instant.
 */
export const TTL = {
  catalogue: 6 * HOUR,
  /**
   * For a catalogue assembled while a source was failing or a deadline expired. It is worth
   * keeping - a menu with most of the subtitles beats one with none - but not for as long,
   * because the missing source is probably back.
   */
  partial: 30 * 60_000,
  body: 30 * DAY,
  retimed: 30 * DAY,
} as const;

export class Cache {
  private readonly db: DatabaseSync;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(join(dir, 'cache.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS bodies (
        id TEXT PRIMARY KEY, body BLOB NOT NULL, cues TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS catalogues (
        key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS retimed (
        key TEXT PRIMARY KEY, body BLOB NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS refs (
        key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
    `);
  }

  private live<T>(table: string, column: string, key: string, now: number): T | null {
    const row = this.db
      .prepare(`SELECT ${column} AS v FROM ${table} WHERE key = ? AND expires_at > ?`)
      .get(key, now) as { v: T } | undefined;
    return row ? row.v : null;
  }

  getBody(id: string, now: number = Date.now()): Buffer | null {
    const row = this.db
      .prepare('SELECT body FROM bodies WHERE id = ? AND expires_at > ?')
      .get(id, now) as { body: Uint8Array } | undefined;
    return row ? Buffer.from(row.body) : null;
  }

  getCues(id: string, now: number = Date.now()): number[] | null {
    const row = this.db
      .prepare('SELECT cues FROM bodies WHERE id = ? AND expires_at > ?')
      .get(id, now) as { cues: string } | undefined;
    return row ? (JSON.parse(row.cues) as number[]) : null;
  }

  putBody(id: string, body: Buffer, cues: number[], now: number = Date.now()): void {
    this.db
      .prepare(
        'INSERT INTO bodies (id, body, cues, expires_at) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT(id) DO UPDATE SET body = excluded.body, cues = excluded.cues, expires_at = excluded.expires_at',
      )
      .run(id, body, JSON.stringify(cues), now + TTL.body);
  }

  getCatalogue<T>(key: string, now: number = Date.now()): T | null {
    const raw = this.live<string>('catalogues', 'value', key, now);
    return raw === null ? null : (JSON.parse(raw) as T);
  }

  putCatalogue(
    key: string,
    value: unknown,
    now: number = Date.now(),
    ttl: number = TTL.catalogue,
  ): void {
    this.db
      .prepare(
        'INSERT INTO catalogues (key, value, expires_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at',
      )
      .run(key, JSON.stringify(value), now + ttl);
  }

  getRetimed(key: string, now: number = Date.now()): Buffer | null {
    const row = this.db
      .prepare('SELECT body FROM retimed WHERE key = ? AND expires_at > ?')
      .get(key, now) as { body: Uint8Array } | undefined;
    return row ? Buffer.from(row.body) : null;
  }

  putRetimed(key: string, body: Buffer, now: number = Date.now()): void {
    this.db
      .prepare(
        'INSERT INTO retimed (key, body, expires_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET body = excluded.body, expires_at = excluded.expires_at',
      )
      .run(key, body, now + TTL.retimed);
  }

  /**
   * What a served subtitle URL points at: the upstream file and the correction to apply.
   * Kept here rather than encoded into the URL so the link stays short and says nothing
   * about how the answer was reached.
   */
  getRef<T>(key: string, now: number = Date.now()): T | null {
    const raw = this.live<string>('refs', 'value', key, now);
    return raw === null ? null : (JSON.parse(raw) as T);
  }

  putRef(key: string, value: unknown, now: number = Date.now()): void {
    this.db
      .prepare(
        'INSERT INTO refs (key, value, expires_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at',
      )
      .run(key, JSON.stringify(value), now + TTL.body);
  }

  /** Housekeeping only: every read already filters on expiry, so this reclaims disk. */
  sweep(now: number = Date.now()): void {
    for (const table of ['bodies', 'catalogues', 'retimed', 'refs']) {
      this.db.prepare(`DELETE FROM ${table} WHERE expires_at <= ?`).run(now);
    }
  }
}
