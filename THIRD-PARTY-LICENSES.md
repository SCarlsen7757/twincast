# Third-party notices

Twincast itself is MIT licensed — see [LICENSE](LICENSE). That covers the source
code only. The two sections below cover what it _displays_ and what it _depends
on_, which are separate questions.

## Feed content

The release information displayed by this board comes from the public Beckhoff
TwinCAT RSS feed:

- Source: <https://www.beckhoff.com/english/rss/beckhoff-twincat-rss-feed.xml>
- Copyright: **© Beckhoff Automation GmbH & Co. KG**

Beckhoff publishes no explicit reuse licence for the feed. This project therefore
follows ordinary RSS practice rather than claiming a granted licence:

- The copyright notice is read from the feed's own `<copyright>` element and shown
  verbatim in the board footer. It is never hardcoded, so if Beckhoff changes it the
  board follows automatically.
- Every item links back to its Beckhoff page, surfaced on screen as a QR code.
- Item wording is Beckhoff's own. Markup is stripped and the version string is pulled
  out for layout, but the text is not rewritten.
- The board identifies itself as an unofficial display, not affiliated with or
  endorsed by Beckhoff Automation.
- The poller sends a self-identifying `User-Agent` so Beckhoff can recognise, contact
  or block it.

**Beckhoff®**, **TwinCAT®**, **XTS®**, **XPlanar®** and **New Automation Technology**
are registered trademarks of Beckhoff Automation GmbH & Co. KG. This project is not
affiliated with Beckhoff Automation.

This board is intended for **internal display**. Exposing it publicly is a different
question — ask Beckhoff for permission first (`info@beckhoff.com`).

## Runtime dependencies

| Package                                                                   | Licence | Used for                   |
| ------------------------------------------------------------------------- | ------- | -------------------------- |
| [fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser) | MIT     | Parsing the RSS XML        |
| [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)     | MIT     | Generating QR codes as SVG |

`fast-xml-parser` pulls a small set of transitive packages (`strnum`, `xml-naming`,
`is-unsafe`, `@nodable/entities`, `path-expression-matcher`, `fast-xml-builder`,
`anynum`); these are published by the same author as fast-xml-parser itself and are
that package's own modularisation.

The build and lint tooling (`typescript`, `@types/node`, `eslint`, `@eslint/js`,
`typescript-eslint`, `eslint-config-prettier`, `prettier`, `globals`) is
**devDependencies only**. It runs at build
time and is absent from the published image, which installs with `npm ci --omit=dev`.

SQLite is provided by Node's built-in `node:sqlite` module — part of Node.js
(MIT licence), with SQLite itself in the public domain. No separate SQLite package is
installed and nothing is compiled at install time.

## Fonts

The board uses the operating system's own UI font stack (`system-ui`, Segoe UI,
Roboto, DejaVu Sans …) and ships no font files, so there is no font licence to carry.

If you later vendor a webfont into `public/fonts/`, add its licence here — for
example Inter is licensed under the SIL Open Font License 1.1, which requires the
`OFL.txt` to be distributed alongside the font.
