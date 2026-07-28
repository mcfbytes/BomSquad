# pipeline

TypeScript / Node.js workspace (Node 24). The extraction, normalization, and validation engine:

- **mame** — MAME listxml acquisition, streaming XML parser, filter rules, device worklist.
- **validate** — JSON Schema enforcement over `data/` and generated row files.
- **db** — `schemas/schema.sql` application, row-file loading, quality thresholds.
- **build** — the device-map join that turns `extract/*.raw.json` into row files (T6.1), the
  FAIL gates and quality report (T6.4), and `dist/bomsquad.sqlite` (T6.5).

Coverage and the Prospector are **views in `schemas/schema.sql`**, not code here; nothing in
this workspace re-implements what a view computes.

All pipeline stages are deterministic: same inputs produce byte-identical outputs, verified in CI.

## Commands

```
npm run validate     --workspace @bomsquad/pipeline    # data/ + extract/ row files
npm run mame:fetch   --workspace @bomsquad/pipeline    # verified listxml download, cached
npm run mame:extract --workspace @bomsquad/pipeline    # writes extract/*.raw.json
npm run mame:rows    --workspace @bomsquad/pipeline    # writes extract/*.json (row files)
npm run build:db     --workspace @bomsquad/pipeline    # writes dist/bomsquad.sqlite + report
```

`mame:rows` applies the curated `mame_device` dictionary to `extract/machines.raw.json` and
writes `extract/machine.json`, `machine_chip.json`, `machine_unmapped_device.json` and
`dataset_meta.json` (data-model.md §4.2). Its output is committed, so mapping a device is a
reviewable diff of the BOM rows it moves. **Re-run it after any change to `data/mame_device*`**
— CI fails otherwise, and so does the build's `STALE_EXTRACT` gate.

`build:db` loads `data/` plus those row files into `schemas/schema.sql`, applies the one
correction pass of data-model.md §5.1, runs every FAIL gate of data-quality.md §3, then
`ANALYZE`/`VACUUM`s and publishes. It writes nothing until every gate has passed. Pass
`--build-date YYYY-MM-DD` and `--dataset-version` for a release; otherwise the build date
comes from `SOURCE_DATE_EPOCH` and falls back to today (UTC), and `dataset_version` defaults
to the build date (versioning.md §2).

**Corrections are never merged into `extract/`.** `machine_correction` and `machine_system`
are applied by `v_machine` / `v_machine_system` at query time; `machine_chip_correction` is
applied by §5.1's three statements against the loaded database, never against the generated
files. The row files are a pure function of MAME plus the device map.

`mame:fetch` downloads the pinned release's `mameNNNNlx.zip` and verifies its SHA-256
against the release's own published `SHA256SUMS` asset. The archive is cached under
`.cache/mame/<release>/` and re-verified from disk on every run, so a second run issues no
network request at all — offline extraction and CI both depend on that.

`mame:extract` exits non-zero if any extracted row is one `schemas/schema.sql` would
refuse. That is not a lint: a machine MAME describes in a way the DDL cannot store is a
defect in one of the two, and T6.1 will fail on it later and further from the cause.

## Configuration

| File                             | Owns                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `config/mame.json`               | **The pin.** Which MAME release this dataset is built from — and nothing else.                          |
| `config/mame-extract.json`       | **The policy.** Filter rules (parents-only, devices, mechanical, gambling drivers) and worklist sizing. |
| `config/quality-thresholds.json` | Numeric policy for the quality views (data-quality.md §7), and `db_max_bytes`, the hard size ceiling.   |
| `config/build.json`              | ADR 0001's revisit trigger (32 MiB raw / 8 MiB brotli). A warning line, not a ceiling — see below.      |

Bumping MAME is one edit to `config/mame.json`; the loader cross-checks the three
release-bearing fields so a half-edited pin fails before the download rather than after
the parse. Every gambling-driver exclusion carries a written reason, because MAME's XML has
no genre field and each exclusion is therefore a human judgement (see `extract/README.md`).

**Two size numbers, two meanings.** `docs/data-model.md` §4.3 sets a hard ceiling of 48 MB
(`db_max_bytes`, 50 331 648 B) — over it, the build fails with `DB_OVER_BUDGET` and publishes
nothing. `docs/adr/0001-browser-database.md` names a _revisit trigger_ at 32 MiB raw / 8 MiB
brotli, which it derives as "two-thirds of the 48 MiB budget"; crossing it warns and asks for
the whole-file-download decision to be re-opened. One policy, two levels: the ceiling fails,
the trigger warns, and neither number appears in TypeScript.

## Dependencies

One runtime dependency, `ajv` (plus `ajv-formats`), and the restraint is deliberate. Node 24
supplies everything else the pipeline needs: `node:sqlite` for the database, `node:zlib` for
`inflateRaw` and `crc32`, `fetch` for downloads, `node:crypto` for SHA-256. The ZIP reader
(`src/mame/zip.ts`) and XML scanner (`src/mame/xml.ts`) are purpose-built for one archive
and one machine-generated document rather than pulling in general-purpose libraries; both
say in their module comments exactly which constructs they support and which they refuse.

**Edit policy:** CODE. TypeScript source, reviewed via PR. Keep tests comprehensive; any data transformation must be justified by a test. Determinism is non-negotiable.
