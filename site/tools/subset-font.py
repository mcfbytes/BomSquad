#!/usr/bin/env python3
"""Regenerate site/public/fonts/bom-squad-pixel.woff2.

The site self-hosts its pixel display face: the production CSP is
`font-src 'self' data:` (see site/public/staticwebapp.config.json), so a Google
Fonts CDN link is not an option. The shipped file is a subset of Press Start 2P
by CodeMan38, SIL OFL 1.1 — see site/public/fonts/README.md for provenance and
for why the subset is renamed.

Byte-reproducible: the same input TTF always produces a byte-identical woff2, so
a clean-clone rebuild can be diffed against the checked-in file (T9.1).

The one thing that breaks that is `head.modified`. `subset.Options.recalc_timestamp`
is only consulted by `subset.main()`; this script builds the `TTFont` itself, and
`TTFont(...)` defaults to `recalcTimestamp=True`, which stamps wall-clock time
into the header — two runs a second apart then differ at byte 12. Hence both
`recalcTimestamp=False` on load and the explicit re-pin of `head.modified` to the
upstream value below. Nothing else varies: the codepoint list is sorted, and the
Python hash seed provably does not affect the output (verified across seeds
0 / 1 / 12345 / 99991).

Usage:
    pip install 'fonttools[woff]'
    python3 site/tools/subset-font.py PressStart2P-Regular.ttf

Fetch the input from:
    https://github.com/google/fonts/raw/main/ofl/pressstart2p/PressStart2P-Regular.ttf
"""

from __future__ import annotations

import sys
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools import subset

# Everything the chrome can render. Keep in sync with the `unicode-range` in
# site/src/styles/_typography.scss and with the table in the fonts README.
UNICODES: list[int] = sorted(
    list(range(0x20, 0x7F))
    + [
        0x00A0,  # no-break space
        0x00B0,  # degree
        0x00B7,  # middle dot - the coverage badge separator
        0x00D7,  # multiplication sign
        0x2013,  # en dash
        0x2014,  # em dash
        0x2018,  # left single quote
        0x2019,  # right single quote / apostrophe
        0x201C,  # left double quote
        0x201D,  # right double quote
        0x2022,  # bullet
        0x2026,  # ellipsis
        0x2192,  # rightwards arrow
    ]
)

# OFL 1.1 clause 3: a Modified Version may not carry the Reserved Font Name.
FAMILY = "BOM Squad Pixel"
FULL_NAME = "BOM Squad Pixel Regular"
POSTSCRIPT_NAME = "BOMSquadPixel-Regular"
UNIQUE_ID = "BOMSquad:BOMSquadPixel:2026"
DESCRIPTION = (
    "Subset of Press Start 2P by CodeMan38, licensed under the SIL Open Font "
    "License 1.1. Renamed per OFL clause 3 (Reserved Font Name)."
)

OUTPUT = Path(__file__).resolve().parent.parent / "public" / "fonts" / "bom-squad-pixel.woff2"

# `head.modified` on PressStart2P-Regular.ttf v16, in the OpenType epoch
# (seconds since 1904-01-01). Pinned rather than inherited so the output cannot
# start drifting if a future fontTools decides to recalculate it anyway.
HEAD_MODIFIED = 3564561298


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2

    source = Path(argv[1])
    # recalcTimestamp=False is the load-time half of the fix; see the docstring.
    font = TTFont(source, recalcTimestamp=False)

    options = subset.Options()
    options.layout_features = []
    options.hinting = False
    options.desubroutinize = True
    options.drop_tables += ["DSIG"]
    options.name_IDs = list(range(15))
    options.name_legacy = True
    options.notdef_outline = False
    options.recalc_bounds = True
    options.recalc_timestamp = False
    options.prune_unicode_ranges = True

    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=UNICODES)
    subsetter.subset(font)

    renames = {
        1: FAMILY,
        3: UNIQUE_ID,
        4: FULL_NAME,
        6: POSTSCRIPT_NAME,
        10: DESCRIPTION,
        16: FAMILY,
        18: FULL_NAME,
    }
    for record in font["name"].names:
        replacement = renames.get(record.nameID)
        if replacement is not None:
            record.string = replacement

    font["head"].modified = HEAD_MODIFIED

    font.flavor = "woff2"
    font.save(OUTPUT)

    print(f"{OUTPUT}: {OUTPUT.stat().st_size} bytes, {len(font.getGlyphOrder())} glyphs")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
