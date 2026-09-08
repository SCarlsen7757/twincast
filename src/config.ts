import { dirname } from 'node:path';

const num = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};
const bool = (v: string | undefined, d: boolean): boolean =>
  v === undefined ? d : /^(1|true|yes|on)$/i.test(v);

export interface Config {
  port: number;
  feedUrl: string;
  pollIntervalMin: number;
  pollOnStart: boolean;
  dbPath: string;
  heroCount: number;
  railCount: number;
  rotateSeconds: number;
  staleAfterMin: number;
  userAgent: string;
}

/**
 * Built from an env bag rather than reading process.env inline, so the coercion
 * rules can be tested without mutating the real environment.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: num(env.PORT, 8080),
    feedUrl: env.FEED_URL || 'https://www.beckhoff.com/english/rss/beckhoff-twincat-rss-feed.xml',
    pollIntervalMin: num(env.POLL_INTERVAL_MIN, 30),
    pollOnStart: bool(env.POLL_ON_START, true),
    dbPath: env.DB_PATH || './data/board.db',
    heroCount: num(env.HERO_COUNT, 6),
    railCount: num(env.RAIL_COUNT, 8),
    rotateSeconds: num(env.ROTATE_SECONDS, 25),
    staleAfterMin: num(env.STALE_AFTER_MIN, 120),
    // Honest, self-identifying agent. Beckhoff's WAF rejects `curl/*` with 403 but
    // accepts this; we identify ourselves rather than impersonating a browser.
    userAgent: env.USER_AGENT || 'Twincast/1.0 (+https://github.com/SCarlsen7757/twincast)',
  };
}

export const config: Config = loadConfig();

export const dataDir = (): string => dirname(config.dbPath);
