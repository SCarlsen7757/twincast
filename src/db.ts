import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { config, dataDir } from './config.js';
import type { Item, MetaBag, ParsedItem } from './types.js';

let db: DatabaseSync | undefined;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  guid        TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  name        TEXT,
  codes       TEXT,
  family      TEXT,
  version     TEXT,
  channel     TEXT,
  link        TEXT,
  description TEXT,
  pub_date    INTEGER NOT NULL,
  first_seen  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_pub_date ON items(pub_date DESC);
CREATE INDEX IF NOT EXISTS idx_items_family   ON items(family);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

/**
 * node:sqlite returns loose row objects. Every cast in this codebase lives here,
 * at the one place where untyped data enters: the SQL result set. Keeping them in
 * two named helpers means the assertions are greppable, and the row interfaces in
 * types.ts are the single description of what these tables hold -- so if the schema
 * and those interfaces drift apart, this is the one place to look.
 */
const asRow = <T>(v: unknown): T => v as T;
const asRows = <T>(v: unknown[]): T[] => v as T[];

export function openDb(path = config.dbPath): DatabaseSync {
  if (db) return db;
  if (path !== ':memory:') mkdirSync(dataDir(), { recursive: true });
  db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  return db;
}

export function closeDb(): void {
  if (db) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    db = undefined;
  }
}

/**
 * Named rather than positional parameters on purpose: the previous 11-placeholder
 * form meant reordering a column silently wrote titles into `name`, and no type
 * can catch that. Named binding makes the mapping explicit and order-independent.
 */
const UPSERT = `
INSERT INTO items (guid,title,name,codes,family,version,channel,link,description,pub_date,first_seen)
VALUES (:guid,:title,:name,:codes,:family,:version,:channel,:link,:description,:pub_date,:first_seen)
ON CONFLICT(guid) DO UPDATE SET
  title=excluded.title, name=excluded.name, codes=excluded.codes,
  family=excluded.family, version=excluded.version, channel=excluded.channel,
  link=excluded.link, description=excluded.description, pub_date=excluded.pub_date
`;

/**
 * Idempotent bulk upsert. `first_seen` is set on insert only -- it is deliberately
 * absent from the DO UPDATE clause so re-polling never moves it.
 * Returns how many rows were genuinely new.
 */
export function upsertItems(items: readonly ParsedItem[]): number {
  const d = openDb();
  const now = Math.floor(Date.now() / 1000);
  const before = countItems();
  const stmt = d.prepare(UPSERT);
  d.exec('BEGIN');
  try {
    for (const i of items) {
      stmt.run({
        guid: i.guid,
        title: i.title,
        name: i.name,
        codes: i.codes,
        family: i.family,
        version: i.version,
        channel: i.channel,
        link: i.link,
        description: i.description,
        pub_date: i.pub_date,
        first_seen: now,
      });
    }
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
  return countItems() - before;
}

export function countItems(): number {
  return asRow<{ n: number }>(openDb().prepare('SELECT COUNT(*) AS n FROM items').get()).n;
}

export function getLatest(limit = 10): Item[] {
  return asRows<Item>(
    openDb().prepare('SELECT * FROM items ORDER BY pub_date DESC, rowid ASC LIMIT ?').all(limit),
  );
}

export function setMeta(entries: Record<string, string | number | null | undefined>): void {
  const d = openDb();
  const stmt = d.prepare(
    'INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
  );
  for (const [k, v] of Object.entries(entries)) {
    if (v !== undefined && v !== null) stmt.run(k, String(v));
  }
}

export function getMeta(): MetaBag {
  const rows = asRows<{ key: string; value: string }>(
    openDb().prepare('SELECT key,value FROM meta').all(),
  );
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
