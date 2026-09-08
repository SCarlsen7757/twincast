import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config, dataDir } from './config.js';
import type { FeedResult } from './types.js';

const TIMEOUT_MS = 30_000;

const baseHeaders = (): Record<string, string> => ({
  // Self-identifying: Beckhoff's WAF 403s `curl/*` but accepts this. We want them
  // to be able to recognise, contact or block the poller rather than us hiding.
  'User-Agent': config.userAgent,
  Accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
  'Accept-Language': 'en',
});

/**
 * Conditional GET. Returns {status:304} when unchanged, {status:200, xml, etag,
 * lastModified} when new. Throws on transport or non-OK responses.
 */
export async function fetchFeed({
  etag,
  lastModified,
}: { etag?: string; lastModified?: string } = {}): Promise<FeedResult> {
  const headers = baseHeaders();
  if (etag) headers['If-None-Match'] = etag;
  if (lastModified) headers['If-Modified-Since'] = lastModified;

  const res = await fetch(config.feedUrl, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (res.status === 304) return { status: 304 };
  if (!res.ok) throw new Error(`feed responded HTTP ${res.status}`);

  return {
    status: 200,
    xml: await res.text(),
    etag: res.headers.get('etag'),
    lastModified: res.headers.get('last-modified'),
  };
}

const logoPath = (): string => join(dataDir(), 'logo.bin');

/**
 * Cache the channel's own RSS logo locally so the board still renders it with no
 * network. Best-effort: a failure here must never fail a poll.
 */
export async function cacheLogo(imageUrl: string | undefined): Promise<string | null> {
  if (!imageUrl) return null;
  try {
    const res = await fetch(imageUrl, {
      headers: baseHeaders(),
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return null;
    writeFileSync(logoPath(), buf);
    return res.headers.get('content-type') || 'image/jpeg';
  } catch {
    return null;
  }
}

export function readLogo(): Buffer | null {
  const p = logoPath();
  return existsSync(p) ? readFileSync(p) : null;
}
