# Fonts

Build output, but **committed on purpose**: the site must ship the font it renders with, and the CSP
(`font-src 'self' data:`) forbids a CDN. Regenerate with `site/tools/subset-font.py`, don't hand-edit.

## `bom-squad-pixel.woff2`

The pixel display face used for chrome only — brand, headings, badges and stat readouts (TASKS T7.12).
Body copy and data tables deliberately do **not** use it.

|                 |                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------- |
| Upstream        | [Press Start 2P](https://fonts.google.com/specimen/Press+Start+2P) by CodeMan38 (`cody@zone38.net`) |
| Upstream source | `google/fonts` → `ofl/pressstart2p/PressStart2P-Regular.ttf` (v16)                                  |
| License         | SIL Open Font License 1.1 — full text in [`OFL.txt`](./OFL.txt)                                     |
| Modification    | Subset to 108 codepoints, hinting and layout features stripped, `DSIG` dropped                      |
| Size            | 2,388 bytes                                                                                         |

Rebuilding from the upstream TTF reproduces this file byte for byte. That is not free: `TTFont(...)`
defaults to `recalcTimestamp=True` and stamps wall-clock time into `head.modified`, so an earlier
revision of the build script emitted a different file on every run — and a 3-run loop that finished
inside one second made it look reproducible. The script now loads with `recalcTimestamp=False` and
re-pins `head.modified` explicitly. The Python hash seed, which that revision also pinned, provably
makes no difference and is no longer touched.

### Why the family is called "BOM Squad Pixel" and not "Press Start 2P"

"Press Start 2P" is a **Reserved Font Name**. OFL 1.1 clause 3 says no Modified Version may use the
Reserved Font Name as its primary font name without written permission, and a subset is a Modified
Version. The internal `name` table and the CSS `font-family` therefore say `BOM Squad Pixel`; this file
is the acknowledgement of the original author that clause 4 asks for. Nothing else about the outlines
was touched.

### Subset coverage

`U+0020–U+007E` (printable ASCII) plus `U+00A0` (nbsp), `U+00B0` (°), `U+00B7` (· — the coverage-badge
separator), `U+00D7` (×), `U+2013`/`U+2014` (dashes), `U+2018`/`U+2019`/`U+201C`/`U+201D` (curly
quotes), `U+2022` (•), `U+2026` (…), `U+2192` (→).

The `@font-face` rule in `site/src/styles/_typography.scss` declares the same range, so a glyph outside
it falls back to the monospace stack instead of blocking on a font that cannot render it.
