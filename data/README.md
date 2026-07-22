# data

The heart of the project: human-curated JSON records defining chips, implementations, cores, and the mappings that normalize machine data from MAME. Everything in this directory is reviewed via PR, must pass `npm run validate` before merge, and becomes the permanent database of record (Git is the source of truth). See [PLAN.md §3](../PLAN.md#3-data-model) for the complete data model and subdirectory purposes.

**Edit policy:** CURATED. Hand-edited via PR. All changes must pass schema validation. Never modify `extract/` or `dist/` directly — corrections to MAME data go in `overlays/` or `mappings/` instead.
