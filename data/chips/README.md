# data/chips

One JSON file per chip (filename = slug). Records the canonical metadata: manufacturer, model, family, function (CPU, sound, video, etc.), clock, package, year, datasheets, and the MAME device names that map to this chip. Start with the seed list from Phase 3 and grow through contribution. See [PLAN.md §3.1](../../PLAN.md#31-chips-curated--mame-seeded) for the full schema.

**Edit policy:** CURATED. Hand-edited via PR. Slug in filename must match the `id` field. Research each entry — omit unknowns rather than guess. Link to datasheets and cite the function taxonomy.
