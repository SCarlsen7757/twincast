import { writeFileSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { config, dataDir } from './config.js';
import type { FeedResult } from './types.js';
import { safeLink } from './urls.js';
import type { ReadableStreamDefaultReader } from 'node:stream/web';

const TIMEOUT_MS = 30_000;
const MAX_FEED_BYTES = 5 * 1024 * 1024;
const MAX_LOGO_BYTES = 1024 * 1024;

async function boundedBody(res: Response, limit: number): Promise<Buffer> {
  if (Number(res.headers.get('content-length')) > limit) {
    await res.body?.cancel();
    throw new Error(`Response exceeds ${limit} bytes`);
  }
  if (!res.body) return Buffer.alloc(0);
  // Fetch response bodies are byte streams; Undici declares their reader as any.
  const reader = res.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error(`Response exceeds ${limit} bytes`);
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** MIME is derived from the bytes, never from an upstream response header. */
export function logoContentType(buf: Buffer): 'image/png' | 'image/jpeg' | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    return 'image/png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  return null;
}

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
    xml: (await boundedBody(res, MAX_FEED_BYTES)).toString('utf8'),
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
    const safe = safeLink(imageUrl);
    if (!safe) return null;
    const url = new URL(safe);
    if (url.protocol !== 'https:' || url.origin !== new URL(config.feedUrl).origin) return null;
    const res = await fetch(url, {
      headers: baseHeaders(),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const buf = await boundedBody(res, MAX_LOGO_BYTES);
    const type = logoContentType(buf);
    if (!type) return null;
    writeFileSync(logoPath(), buf);
    return type;
  } catch {
    return null;
  }
}

export function readLogo(): Buffer | null {
  try {
    const p = logoPath();
    if (statSync(p).size > MAX_LOGO_BYTES) return null;
    const buf = readFileSync(p);
    return logoContentType(buf) ? buf : null;
  } catch {
    return null;
  }
}

export function logoDigest(): string {
  const logo = readLogo();
  return logo ? createHash('sha256').update(logo).digest('hex') : '';
}
