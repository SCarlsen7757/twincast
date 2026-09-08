import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  norm,
  extractCodes,
  cleanName,
  descriptionText,
  extractVersion,
  extractChannel,
  familyLabel,
  parseFeed,
} from '../src/parse.js';
import { FEED_XML, SINGLE_ITEM_XML } from './fixture.js';

describe('extractCodes', () => {
  test('finds a plain product code', () => {
    assert.deepEqual(extractCodes('New version of TF3600 Analytics'), ['TF3600']);
  });

  // The `x` in CODE_RE's character class is what makes these work. Without it,
  // 7 items in the live feed lose their code entirely.
  test('finds wildcard codes', () => {
    assert.deepEqual(extractCodes('TF55xx TwinCAT 3 Motion'), ['TF55xx']);
    assert.deepEqual(extractCodes('TF7xxx Vision'), ['TF7xxx']);
  });

  test('finds every code in a multi-code title', () => {
    assert.deepEqual(extractCodes('Update of TC1300/TE1300'), ['TC1300', 'TE1300']);
  });

  test('covers all five family prefixes', () => {
    assert.deepEqual(extractCodes('TF1000 TE2000 TC3000 TS4000 TX5000'), [
      'TF1000',
      'TE2000',
      'TC3000',
      'TS4000',
      'TX5000',
    ]);
  });

  test('ignores codes that are too short and titles with none', () => {
    assert.deepEqual(extractCodes('TF12 is not a code'), []);
    assert.deepEqual(extractCodes('Beckhoff at the SPS trade fair'), []);
  });
});

describe('cleanName', () => {
  test('strips each boilerplate prefix', () => {
    assert.equal(cleanName('New version of TF3600 Analytics'), 'Analytics');
    assert.equal(cleanName('New versions of TF3600 Analytics'), 'Analytics');
    assert.equal(cleanName('Update of TF3600 Analytics'), 'Analytics');
    assert.equal(cleanName('Release of TF3600 Analytics'), 'Analytics');
    assert.equal(cleanName('First release of TF3600 Analytics'), 'Analytics');
  });

  test('strips leading codes and their separators', () => {
    assert.equal(cleanName('TC1300/TE1300: Runtime'), 'Runtime');
    assert.equal(cleanName('TF3600 - Analytics'), 'Analytics');
    assert.equal(cleanName('TF3600 – Analytics'), 'Analytics');
  });

  // Stripping the prefix and then the code leaves nothing, so the whole
  // normalised title is used rather than showing an empty product name.
  test('falls back to the full normalised title when stripping would empty it', () => {
    assert.equal(cleanName('New version of TF3600'), 'New version of TF3600');
  });
});

describe('descriptionText', () => {
  test('drops anchors whose only text is a call to action', () => {
    assert.equal(descriptionText('Text <a href="/x">Learn more</a> here'), 'Text here');
    assert.equal(descriptionText('Text <a href="/x">Read more</a>'), 'Text');
  });

  // Anchors carrying real content must keep their text -- e.g. a support address.
  test('keeps the text of anchors that carry real content', () => {
    assert.equal(
      descriptionText('Please <a href="mailto:s@b.com">contact support@b.com</a>'),
      'Please contact support@b.com',
    );
  });

  test('turns breaks and paragraph ends into spaces and collapses runs', () => {
    assert.equal(descriptionText('a<br>b<br/>c</p>d'), 'a b c d');
    assert.equal(descriptionText('a     b'), 'a b');
  });

  test('handles null and undefined', () => {
    assert.equal(descriptionText(undefined), '');
    assert.equal(descriptionText(null), '');
  });
});

describe('norm', () => {
  test('collapses the U+00A0 the feed puts inside product names', () => {
    assert.equal(norm('TwinCAT 3'), 'TwinCAT 3');
  });

  test('trims and handles nullish input', () => {
    assert.equal(norm('  a  b  '), 'a b');
    assert.equal(norm(undefined), '');
  });
});

describe('extractVersion', () => {
  test('reads 2-, 3- and 4-segment versions', () => {
    assert.equal(extractVersion('version 1.2'), '1.2');
    assert.equal(extractVersion('the version 3.4.10 is out'), '3.4.10');
    assert.equal(extractVersion('Version 3.3.31.0 released'), '3.3.31.0');
  });

  test('returns null when there is no version', () => {
    assert.equal(extractVersion('no version here'), null);
  });
});

describe('extractChannel', () => {
  test('detects both channels case-insensitively', () => {
    assert.equal(extractChannel('in the testing feed'), 'testing');
    assert.equal(extractChannel('in the Stable Feed'), 'stable');
    assert.equal(extractChannel('no channel mentioned'), null);
  });
});

describe('familyLabel', () => {
  test('maps each family and falls back for unknown or null', () => {
    assert.equal(familyLabel('TF'), 'Function');
    assert.equal(familyLabel('TE'), 'Engineering');
    assert.equal(familyLabel('TC'), 'Base');
    assert.equal(familyLabel('TS'), 'Supplement');
    assert.equal(familyLabel('TX'), 'Other');
    assert.equal(familyLabel('ZZ'), 'Release');
    assert.equal(familyLabel(null), 'Release');
  });
});

describe('parseFeed', () => {
  const { meta, items } = parseFeed(FEED_XML);

  test('lifts channel metadata', () => {
    assert.equal(meta.channel_title, 'Beckhoff TwinCAT RSS Feed');
    assert.equal(meta.channel_copyright, 'Beckhoff Automation GmbH & Co. KG');
    assert.equal(meta.channel_ttl, '60');
    assert.equal(meta.channel_image, 'https://www.beckhoff.com/logo.jpg');
  });

  test('drops items with no guid', () => {
    assert.equal(items.length, 4);
    assert.ok(!items.some((i) => i.title.includes('TF6100')));
  });

  test('sorts newest first regardless of document order', () => {
    const dates = items.map((i) => i.pub_date);
    assert.deepEqual(
      dates,
      [...dates].sort((a, b) => b - a),
    );
  });

  // <guid isPermaLink="false"> parses to an object with a '#text' member rather
  // than a bare string. Reading it as a bare string yields '' and drops the item.
  test('reads the object form of guid', () => {
    const item = items.find((i) => i.codes === 'TC1300/TE1300');
    assert.ok(item);
    assert.equal(item.guid, 'urn:beckhoff:item:3');
  });

  test('derives family from the first code and joins codes with a slash', () => {
    const multi = items.find((i) => i.guid === 'urn:beckhoff:item:3');
    assert.equal(multi?.codes, 'TC1300/TE1300');
    assert.equal(multi?.family, 'TC');
  });

  // parseTagValue:false exists so "3.4.10" is not coerced to a Number.
  test('keeps version numbers as strings', () => {
    const first = items.find((i) => i.guid === 'https://www.beckhoff.com/item/1');
    assert.equal(first?.version, '3.4.10');
    assert.equal(typeof first?.version, 'string');
    assert.equal(first?.channel, 'stable');
  });

  test('leaves codeless, versionless items with nulls', () => {
    const news = items.find((i) => i.guid === 'https://www.beckhoff.com/item/4');
    assert.equal(news?.codes, '');
    assert.equal(news?.family, null);
    assert.equal(news?.version, null);
    assert.equal(news?.channel, null);
  });

  test('falls back to the channel link when an item has none', () => {
    const news = items.find((i) => i.guid === 'https://www.beckhoff.com/item/4');
    assert.equal(news?.link, 'https://www.beckhoff.com/en-en/');
  });

  test('wraps a single <item> feed into an array', () => {
    const single = parseFeed(SINGLE_ITEM_XML);
    assert.equal(single.items.length, 1);
    assert.equal(single.items[0]?.codes, 'TF1000');
  });

  test('throws on a document that is not RSS 2.0', () => {
    assert.throws(() => parseFeed('<html><body>nope</body></html>'), /not an RSS 2\.0 document/);
  });
});
