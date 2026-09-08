/**
 * Shapes that cross module boundaries. Types that only one module cares about
 * (the raw fast-xml-parser output, the Config object) stay in that module.
 */

/** One release row, exactly as the `items` table stores it. */
export interface Item {
  guid: string;
  title: string;
  name: string;
  /** Slash-joined product codes, e.g. "TC1300/TE1300". */
  codes: string;
  family: string | null;
  version: string | null;
  channel: 'stable' | 'testing' | null;
  link: string;
  description: string;
  /** Epoch seconds. */
  pub_date: number;
  /** Epoch seconds. Set on insert only -- re-polling never moves it. */
  first_seen: number;
}

/** What parse.ts produces: an Item before the database stamps `first_seen`. */
export type ParsedItem = Omit<Item, 'first_seen'>;

/** An Item decorated with its inline QR SVG, the way the renderer wants it. */
export type ItemWithQr = Item & { qr: string };

/** Channel-level metadata lifted out of the feed. */
export interface ChannelMeta {
  channel_title: string;
  channel_link: string;
  channel_copyright: string;
  channel_ttl: string;
  channel_image: string;
  last_build_date: string;
}

/**
 * The `meta` table is an open key/value bag -- channel metadata, poll bookkeeping
 * and the logo content type all share it. Left open rather than a closed union of
 * keys: getMeta() genuinely returns whatever is in the table, and
 * `noUncheckedIndexedAccess` already forces every read through a guard.
 */
export type MetaBag = Record<string, string | undefined>;

/** What poller.ts holds in memory between requests. */
export interface StoredSnapshot {
  contentRevision: string;
  apiItems: Item[];
  items: ItemWithQr[];
  meta: MetaBag;
  itemCount: number;
  lastSuccess: number | null;
  lastChecked: number | null;
  lastError: string | null;
}

/**
 * What getSnapshot() hands the HTTP layer. `stale` and `ageSec` are derived per
 * call rather than stored, because they depend on elapsed time rather than on the
 * last poll's outcome -- so they live here and not on StoredSnapshot.
 */
export interface Snapshot extends StoredSnapshot {
  ageSec: number | null;
  stale: boolean;
}

export type FeedResult =
  { status: 304 } | { status: 200; xml: string; etag: string | null; lastModified: string | null };

export type PollResult =
  | { status: 'not-modified' }
  | { status: 'unchanged' }
  | { status: 'updated'; parsed: number; added: number }
  | { status: 'error'; error: string };
