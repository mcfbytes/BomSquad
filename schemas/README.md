# schemas

Two things live here, and `schema.sql` is normative over the other:

- **`schema.sql`** — the complete SQLite DDL: every table, view, index, `CHECK`, and foreign key. Per its own
  header (kept honest by a test that reads it back from `sqlite_master`): **36 tables · 21 views · 34 explicit
  indexes**. This is where structure is decided — see [`docs/data-model.md`](../docs/data-model.md) for the
  normative prose, [`docs/coverage.md`](../docs/coverage.md) for the four coverage views, and
  [`docs/data-quality.md`](../docs/data-quality.md) for the six quality views.
- **`*.schema.json`** — JSON Schema 2020-12 validators for the row files under `data/` (and, once populated,
  `extract/`). One schema per table, named after it (`chip.schema.json` validates rows destined for the `chip`
  table, and so on). 35 of the 36 tables have one; the exception is `threshold`, which is never a curated row
  file — it is populated at build time by `pipeline/src/db/thresholds.ts` from
  `pipeline/config/quality-thresholds.json`, not authored under `data/`.

Three more files round out the 38 `.schema.json` files in this directory, none of them a per-table row schema:

- **`rowfile.schema.json`** — the container schema. A row file is a JSON object whose top-level keys are table
  names and whose values are arrays of rows; this schema has one property per table name, each `$ref`-ing that
  table's row schema. `pipeline validate` runs every file under `data/` against this schema first.
- **`common.schema.json`** — shared `$defs` (the `slug` and `identifier` grammars, and other scalar patterns)
  that the per-table schemas `$ref`. Each pattern here mirrors a `CHECK` constraint in `schema.sql`; a test
  (`describe('every DDL grammar equals the JSON Schema pattern that mirrors it')`) brute-forces string corpora
  against both and fails on any disagreement.
- **`quality-report.schema.json`** — validates `dist/quality-report.json`, a build artifact, not a curated row
  file.

## Edit policy

CURATED, hand-edited via PR, but not independently authoritative: a row schema's job is to agree with
`schema.sql`, never to add a rule the database doesn't also enforce. Concretely:

- Changing a table's shape (add/remove/rename a column, tighten a `CHECK`) means editing `schema.sql` **and**
  the matching row schema in the same PR. `diffRowSchemas()` (`pipeline/src/validate/index.ts`) compares every
  row schema against the live DDL — property names and order, `required`, each property's resolved SQL type,
  and pattern coverage on every string-shaped `CHECK` — and the pipeline test suite fails on drift.
- Adding a table needs a new `*.schema.json` and a new property on `rowfile.schema.json`, unless the table is
  populated at build time like `threshold` rather than authored as a row file.
- New scalar grammars belong in `common.schema.json` as a `$def`, referenced from wherever they apply, not
  copy-pasted across per-table schemas.

There is no normalizer, emitter, or third code path to keep in sync — validation is `ajv` over these schemas
plus SQLite's own constraint checking (`pipeline/src/db/schema.ts`, `pipeline/src/validate/index.ts`). See
`pipeline/src/validate/index.ts`'s module docstring for the three validation layers this directory feeds.
