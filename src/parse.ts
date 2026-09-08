import { XMLParser } from 'fast-xml-parser';
import type { ChannelMeta, ParsedItem } from './types.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Keep everything as strings: version numbers like "3.4.10" and numeric-looking
  // guids must not be coerced to Number.
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
});

/**
 * fast-xml-parser's parse() is declared `any`, so the feed boundary is untyped.
 * These describe only what is actually read. A text node comes back bare, or
 * wrapped in `#text` when the element carries attributes (`<guid isPermaLink=...>`).
 */
type XmlText = string | { '#text'?: string } | null | undefined;

interface RawItem {
  title?: XmlText;
  guid?: XmlText;
  link?: XmlText;
  description?: XmlText;
  pubDate?: XmlText;
}

interface RawChannel {
  title?: XmlText;
  link?: XmlText;
  copyright?: XmlText;
  ttl?: XmlText;
  lastBuildDate?: XmlText;
  image?: { url?: XmlText };
  item?: RawItem | RawItem[];
}

interface RawFeed {
  rss?: { channel?: RawChannel };
}

/** The feed uses U+00A0 inside product names ("TwinCAT\u00a03", 130 occurrences). */
export const norm = (s: string | null | undefined): string =>
  String(s ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Read a text node in either of the two shapes fast-xml-parser produces.
 * The `v !== null` check is load-bearing: `typeof null === 'object'`, so without
 * it an empty `<guid/>` (which parses to null) throws on the property access.
 */
const nodeText = (v: XmlText): string => norm(typeof v === 'object' && v !== null ? v['#text'] : v);

/**
 * Product codes, e.g. TF3600, TE1300, TC1300, TS6100.
 * The `x` in the character class is required for wildcard codes (TF55xx, TF7xxx);
 * without it 7 items in the live feed lose their code.
 */
const CODE_RE = /\b(T[FECSX][0-9x]{3,4})\b/g;

/** Boilerplate that prefixes ~94% of titles. */
const TITLE_PREFIX_RE =
  /^(new\s+versions?\s+of|new\s+version\s+of|update\s+of|release\s+of|first\s+release\s+of)\s*/i;

/** Leading product codes plus their separators, so only the product name remains. */
const LEADING_CODES_RE = /^((T[FECSX][0-9x]{3,4})[/,\s]*)+[:\-\u2013]?\s*/;

const FAMILY_LABELS: Record<string, string> = {
  TF: 'Function',
  TE: 'Engineering',
  TC: 'Base',
  TS: 'Supplement',
  TX: 'Other',
};

export function extractCodes(title: string): string[] {
  return [...norm(title).matchAll(CODE_RE)]
    .map((m) => m[1])
    .filter((c): c is string => c !== undefined);
}

export function cleanName(title: string): string {
  let n = norm(title).replace(TITLE_PREFIX_RE, '');
  n = n.replace(LEADING_CODES_RE, '');
  return n.trim() || norm(title);
}

/**
 * Strip markup to readable text. Anchors whose only text is a call to action are
 * dropped entirely (we surface the link ourselves as a QR), but anchors carrying
 * real content -- e.g. "please contact support@beckhoff.com" -- keep their text.
 */
export function descriptionText(html: string | null | undefined): string {
  return norm(
    String(html ?? '')
      .replace(/<a\b[^>]*>\s*(learn\s+more|read\s+more|more\s+information|more)\s*<\/a>/gi, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/p>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  );
}

export function extractVersion(text: string): string | null {
  const m = /version\s+((?:\d+\.){1,3}\d+)/i.exec(text);
  return m?.[1] ?? null;
}

export function extractChannel(text: string): 'stable' | 'testing' | null {
  const t = text.toLowerCase();
  if (t.includes('testing feed')) return 'testing';
  if (t.includes('stable feed')) return 'stable';
  return null;
}

const asArray = <T>(v: T | T[] | undefined | null): T[] =>
  v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];

/** RFC-822 date -> epoch seconds; falls back to now when unparseable. */
function toEpoch(pubDate: XmlText): number {
  const t = Date.parse(nodeText(pubDate));
  return Number.isFinite(t) ? Math.floor(t / 1000) : Math.floor(Date.now() / 1000);
}

export function parseFeed(xml: string): { meta: ChannelMeta; items: ParsedItem[] } {
  const doc = parser.parse(xml) as RawFeed;
  const channel = doc?.rss?.channel;
  if (!channel) throw new Error('not an RSS 2.0 document: no rss>channel');

  const meta: ChannelMeta = {
    channel_title: nodeText(channel.title),
    channel_link: nodeText(channel.link),
    channel_copyright: nodeText(channel.copyright),
    channel_ttl: nodeText(channel.ttl),
    channel_image: nodeText(channel.image?.url),
    last_build_date: nodeText(channel.lastBuildDate),
  };

  const items = asArray(channel.item)
    .map((raw): ParsedItem | null => {
      const title = nodeText(raw.title);
      const guid = nodeText(raw.guid);
      if (!title || !guid) return null;

      const description = descriptionText(nodeText(raw.description));
      const codes = extractCodes(title);

      return {
        guid,
        title,
        name: cleanName(title),
        codes: codes.join('/'),
        family: codes[0]?.slice(0, 2) ?? null,
        version: extractVersion(description),
        channel: extractChannel(description),
        link: nodeText(raw.link) || meta.channel_link,
        description,
        pub_date: toEpoch(raw.pubDate),
      };
    })
    .filter((i): i is ParsedItem => i !== null)
    // Don't trust feed ordering.
    .sort((a, b) => b.pub_date - a.pub_date);

  return { meta, items };
}

export const familyLabel = (family: string | null): string =>
  (family && FAMILY_LABELS[family]) || 'Release';
