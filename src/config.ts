import { dirname } from 'node:path';

function numberSetting(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  min: number,
  max: number,
  integer = true,
): number {
  if (env[key] === undefined) return fallback;
  const n = Number(env[key]);
  if (
    !env[key]?.trim() ||
    !Number.isFinite(n) ||
    n < min ||
    n > max ||
    (integer && !Number.isInteger(n))
  ) {
    throw new Error(
      `${key} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}`,
    );
  }
  return n;
}
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
    port: numberSetting(env, 'PORT', 8080, 1, 65535),
    feedUrl: env.FEED_URL || 'https://www.beckhoff.com/english/rss/beckhoff-twincat-rss-feed.xml',
    pollIntervalMin: numberSetting(env, 'POLL_INTERVAL_MIN', 30, 0.1, 1440, false),
    pollOnStart: bool(env.POLL_ON_START, true),
    dbPath: env.DB_PATH || './data/board.db',
    heroCount: numberSetting(env, 'HERO_COUNT', 6, 1, 8),
    railCount: numberSetting(env, 'RAIL_COUNT', 8, 1, 8),
    rotateSeconds: numberSetting(env, 'ROTATE_SECONDS', 25, 5, 300),
    staleAfterMin: numberSetting(env, 'STALE_AFTER_MIN', 120, 1, 10080, false),
    // Honest, self-identifying agent. Beckhoff's WAF rejects `curl/*` with 403 but
    // accepts this; we identify ourselves rather than impersonating a browser.
    userAgent: env.USER_AGENT || 'Twincast/1.0 (+https://github.com/SCarlsen7757/twincast)',
  };
}

export const config: Config = loadConfig();

export const dataDir = (): string => dirname(config.dbPath);
