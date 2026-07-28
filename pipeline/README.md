# pipeline

TypeScript / Node.js workspace (Node 24). The extraction, normalization, and validation engine:

- **mame** — MAME listxml acquisition, streaming XML parser, filter rules, device worklist.
- **validate** — JSON Schema enforcement over `data/` and generated row files.
- **db** — `schemas/schema.sql` application, row-file loading, quality thresholds.
- **normalize/join** — merge `extract/` + `data/` into the canonical model.
- **coverage** — per-machine and per-family implementation coverage (views, not code).
- **emit** — `dist/bomsquad.sqlite`.

All pipeline stages are deterministic: same inputs produce byte-identical outputs, verified in CI.

## Commands

```
npm run validate     --workspace @bomsquad/pipeline    # data/ + extract/ row files
npm run mame:fetch   --workspace @bomsquad/pipeline    # verified listxml download, cached
npm run mame:extract --workspace @bomsquad/pipeline    # writes extract/*.raw.json
```

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
| `config/quality-thresholds.json` | Numeric policy for the quality views (data-quality.md §7).                                              |

Bumping MAME is one edit to `config/mame.json`; the loader cross-checks the three
release-bearing fields so a half-edited pin fails before the download rather than after
the parse. Every gambling-driver exclusion carries a written reason, because MAME's XML has
no genre field and each exclusion is therefore a human judgement (see `extract/README.md`).

## Dependencies

One runtime dependency, `ajv` (plus `ajv-formats`), and the restraint is deliberate. Node 24
supplies everything else the pipeline needs: `node:sqlite` for the database, `node:zlib` for
`inflateRaw` and `crc32`, `fetch` for downloads, `node:crypto` for SHA-256. The ZIP reader
(`src/mame/zip.ts`) and XML scanner (`src/mame/xml.ts`) are purpose-built for one archive
and one machine-generated document rather than pulling in general-purpose libraries; both
say in their module comments exactly which constructs they support and which they refuse.

**Edit policy:** CODE. TypeScript source, reviewed via PR. Keep tests comprehensive; any data transformation must be justified by a test. Determinism is non-negotiable.
