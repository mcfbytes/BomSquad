# data/overlays

Hand corrections to MAME machine data. Used when MAME's XML abstracts chips away (common for consoles) or contains errors. One JSON file per corrected machine (filename = MAME machine ID). Never edit `extract/` directly — corrections always go here, so re-extraction does not lose your fixes. See [PLAN.md §3.5](../../PLAN.md#35-mapping--overlay-files-curated--where-human-judgment-lives) for merge semantics.

**Edit policy:** CURATED. Hand-edited via PR. Overlays are deep-merged at build time; document why each correction exists. Only override MAME data when extracting a fresh XML would lose accurate information (consoles especially).
