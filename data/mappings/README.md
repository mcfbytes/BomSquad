# data/mappings

Where human judgment lives. Three critical files:

1. `mame-device-map.json` — MAME device name → canonical chip slug (e.g., `"m68000" → "m68000"`). Unmapped non-ignored devices flow through as `unknown:*`.
2. `platform-families.json` — machine → board family grouping (Sega System 16, CPS-1, Neo Geo MVS, etc.).
3. `equivalences.json` — chip equivalence classes and directional `provides` edges (e.g., YM3438 ≈ YM2612; a 68010 implementation can satisfy a 68000 socket).

See [PLAN.md §3.5](../../PLAN.md#35-mapping--overlay-files-curated--where-human-judgment-lives) for details and Phase 3 for the curation process.

**Edit policy:** CURATED. Hand-edited via PR. These files drive the normalization pipeline; every entry must be justified. Unmapped devices get a research note. Mappings are the highest-leverage curation task.
