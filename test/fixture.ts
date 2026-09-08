/**
 * A hand-written RSS 2.0 document shaped like the live Beckhoff feed. Kept as a
 * TypeScript template string rather than a .xml file so it stays inside tsc's
 * view and needs no copy step into dist/.
 *
 * Covers, in order: a plain item; a wildcard product code; a multi-code title
 * with a U+00A0 inside the product name and an object-form <guid>; an item whose
 * description carries both a call-to-action anchor and a real one; an item with
 * no product code and an out-of-order pubDate; and an item with no <guid> at all,
 * which must be dropped.
 */
export const FEED_XML = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0">
  <channel>
    <title>Beckhoff TwinCAT RSS Feed</title>
    <link>https://www.beckhoff.com/en-en/</link>
    <copyright>Beckhoff Automation GmbH &amp; Co. KG</copyright>
    <ttl>60</ttl>
    <lastBuildDate>Mon, 01 Sep 2026 08:00:00 GMT</lastBuildDate>
    <image><url>https://www.beckhoff.com/logo.jpg</url></image>

    <item>
      <title>New version of TF3600 TwinCAT 3 Condition Monitoring</title>
      <guid>https://www.beckhoff.com/item/1</guid>
      <link>https://www.beckhoff.com/download/1</link>
      <description>&lt;p&gt;The version 3.4.10 is available in the stable feed.&lt;/p&gt;</description>
      <pubDate>Mon, 01 Sep 2026 08:00:00 GMT</pubDate>
    </item>

    <item>
      <title>New versions of TF55xx TwinCAT 3 Motion</title>
      <guid>https://www.beckhoff.com/item/2</guid>
      <link>https://www.beckhoff.com/download/2</link>
      <description>Version 3.3.31.0 has been released to the testing feed.</description>
      <pubDate>Sun, 31 Aug 2026 08:00:00 GMT</pubDate>
    </item>

    <item>
      <title>Update of TC1300/TE1300 TwinCAT\u00a03 C++</title>
      <guid isPermaLink="false">urn:beckhoff:item:3</guid>
      <link>https://www.beckhoff.com/download/3</link>
      <description>&lt;a href="https://x"&gt;Learn more&lt;/a&gt; about version 1.2, or &lt;a href="mailto:s@beckhoff.com"&gt;contact support@beckhoff.com&lt;/a&gt;.</description>
      <pubDate>Sat, 30 Aug 2026 08:00:00 GMT</pubDate>
    </item>

    <item>
      <title>Beckhoff at the SPS trade fair</title>
      <guid>https://www.beckhoff.com/item/4</guid>
      <description>A news item with no product code and no version.</description>
      <pubDate>Fri, 29 Aug 2026 08:00:00 GMT</pubDate>
    </item>

    <item>
      <title>New version of TF6100 OPC UA</title>
      <description>Dropped: this item has no guid.</description>
      <pubDate>Thu, 28 Aug 2026 08:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

/** A feed with exactly one <item>, which fast-xml-parser hands back unwrapped. */
export const SINGLE_ITEM_XML = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0">
  <channel>
    <title>One</title>
    <link>https://example.invalid/</link>
    <item>
      <title>New version of TF1000 Thing</title>
      <guid>https://example.invalid/1</guid>
      <description>version 1.0.0</description>
      <pubDate>Mon, 01 Sep 2026 08:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;
