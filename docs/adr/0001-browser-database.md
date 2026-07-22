# ADR 0001 — How the browser queries the database

- **Status:** Accepted
- **Date:** 2026-07-22
- **Task:** T1.8
- **Supersedes:** nothing
- **Depends on:** `schemas/schema.sql` — the shipped DDL, **36 tables · 21 views · 34 explicit indexes**,
  `STRICT, WITHOUT ROWID` (spec: `docs/data-model.md` 2.0.0 + `docs/coverage.md` §3.4 + `docs/data-quality.md`
  Appendix Q). Those three counts are re-read from `sqlite_master` by the spike named below, in each engine.

## Context

The maintainer asked for a real relational engine client-side:

> "Perhaps we can use a back-end DB in browser to support querying. e.g. SQLite in browser hosting the data
> for the SPA."

and, on being shown the options:

> "Any common in-browser RDBMS should work great, this is a simple and small dataset and any capable b-tree
> implementation will be more than enough. SQLite is pretty nice though."

T1.1r already made `dist/bomsquad.sqlite` the primary published artifact, and the five canonical queries are
plain SQL over views. So the SPA does not need a query API — it needs a SQLite engine and one file.

Two things constrain the choice:

1. **Hosting is Azure Static Web Apps.** Cross-origin isolation (`Cross-Origin-Opener-Policy: same-origin` +
   `Cross-Origin-Embedder-Policy: require-corp`) to unlock `SharedArrayBuffer` is intrusive: it breaks every
   cross-origin subresource that does not opt in with CORP/CORS, and it is a global header change on a site
   that currently has none. Any option that requires it starts a long way behind.
2. **The database is read-only in the browser.** It is rebuilt by CI and republished. Nothing in the SPA
   writes. So persistence backends — the entire reason OPFS exists — buy us nothing but a cache.

Those two together collapse the problem: we need "load a prebuilt byte array, run SELECTs". That is the
cheapest thing every candidate does.

## Options

All facts below were checked on 2026-07-22 against the npm registry and the projects' own documentation.
Sizes are of the actual published tarball contents, measured locally by
`pipeline/src/spike/verify-browser-engines.ts` from the installed `node_modules` tree. Every SQLite version
quoted for A and B is the answer that engine gave to `SELECT sqlite_version()` in that same run.

### A. `@sqlite.org/sqlite-wasm` 3.53.0-build1

|                       |                                                                                                                                                                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Maintenance           | Published **2026-04-21**. Maintainers `sgbeal` (SQLite core developer) and `tomayac`. Repo `github.com/sqlite/sqlite-wasm` — the SQLite project's own.                                                                                                                                                 |
| Licence               | Apache-2.0 (`package.json`).                                                                                                                                                                                                                                                                           |
| SQLite version        | **3.53.0**, measured: `sqlite3.version.libVersion` and `SELECT sqlite_version()` both answer `3.53.0`, `libVersionNumber` 3053000, source id `2026-04-09 11:41:38 4525003a53`.                                                                                                                         |
| Runtime payload       | `dist/index.mjs` 578 559 B + `dist/sqlite3.wasm` 864 752 B = **1 443 311 B raw / 556 853 B gzip-9 / 473 038 B brotli-11** (re-measured 2026-07-22).                                                                                                                                                    |
| Types                 | Ships `dist/index.d.mts`.                                                                                                                                                                                                                                                                              |
| COOP/COEP             | **Not required for our use.** Per the project's `persistence.md`, only the `opfs` VFS needs `SharedArrayBuffer` and therefore the headers; `opfs-sahpool` explicitly "does not require COOP/COEP HTTP headers", and a transient in-memory database requires nothing at all. We use the in-memory path. |
| Prebuilt read-only DB | Yes — `sqlite3_deserialize()` over the fetched bytes. **Verified** (below).                                                                                                                                                                                                                            |

### B. `sql.js` 1.14.1

|                       |                                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Maintenance           | Published **2026-03-04**. Maintainers `lovasoa`, `kripken`. Actively maintained.                                                                                                            |
| Licence               | MIT.                                                                                                                                                                                        |
| SQLite version        | **3.49.1**, measured: `SELECT sqlite_version()` answers `3.49.1`. Recent enough for `STRICT` (3.37+) and partial indexes, and it ran the whole schema (below).                              |
| Runtime payload       | `dist/sql-wasm.js` 46 406 B + `dist/sql-wasm.wasm` 659 730 B = **706 136 B raw / 339 704 B gzip-9 / 293 378 B brotli-11** (re-measured 2026-07-22). Smallest of the three by 175 KB brotli. |
| Types                 | `sql.js` types are a separate `@types/sql.js` package.                                                                                                                                      |
| COOP/COEP             | Not required. No `SharedArrayBuffer` anywhere; it has no VFS and no persistence.                                                                                                            |
| Prebuilt read-only DB | Yes, and it is the library's headline API: `new SQL.Database(uint8Array)`. **Verified** (below).                                                                                            |

### C. `wa-sqlite`

The **npm package `wa-sqlite@1.0.0` is not the upstream project.** It was published 2024-01-05 by
`gabrieldevunstatic`, it is the only version ever published under that name, and npm reports its licence as
**Proprietary**. Upstream is `rhashimoto/wa-sqlite`, which is MIT since 2023-02-10 and whose latest release is
**v1.1.1 (2026-04-23)** — i.e. the npm package is a stale third-party republish two minor versions behind an
actively maintained repo that does not itself publish to npm.

The mirror bundles **SQLite 3.44.0** (string extracted from `dist/wa-sqlite.wasm`); its synchronous build is
`dist/wa-sqlite.mjs` 42 355 B + `dist/wa-sqlite.wasm` 558 343 B = 600 698 B raw / 249 240 B brotli-11, the
smallest of the four.

Consuming it means either taking a proprietary-labelled mirror or vendoring `dist/` from a GitHub tag. Its
selling point is custom VFS support (IndexedDB, OPFS variants, access-handle pools) — that is a _write_ and
_persistence_ feature, and we have neither requirement. Rejected on supply chain, not on quality.

### D. `sql.js-httpvfs` 0.8.12

Published **2022-09-23**; single maintainer `phiresky`; no release in nearly four years. Assessed but
**excluded by policy** (the project forbids building on it) and by need: it exists to page a large database
over HTTP `Range` requests, and §"Size" below shows we do not have a large database. It also pins an old
`sql.js`: the bundled `dist/sql-wasm.wasm` reports **SQLite 3.35.0**, which predates `STRICT` tables
(3.37) — our schema would not even load.

### Summary

|                   | sqlite-wasm                  | sql.js     | wa-sqlite (npm)                     | sql.js-httpvfs |
| ----------------- | ---------------------------- | ---------- | ----------------------------------- | -------------- |
| Last published    | 2026-04-21                   | 2026-03-04 | 2024-01-05                          | 2022-09-23     |
| Maintained        | yes (SQLite project)         | yes        | mirror, stale                       | **no**         |
| Licence           | Apache-2.0                   | MIT        | "Proprietary" on npm (MIT upstream) | Apache-2.0     |
| SQLite            | 3.53.0                       | 3.49.1     | 3.44.0                              | 3.35.0         |
| Brotli payload    | 462 KB                       | 287 KB     | 243 KB (sync build)                 | 410 KB         |
| Needs COOP/COEP   | **no** (in-memory / SAHPool) | no         | no (some VFS do)                    | no             |
| Reads prebuilt DB | yes                          | yes        | yes                                 | yes (ranged)   |

## The size question

### Estimate, with arithmetic

Scale per the task brief: ~14 000 machines after parents-only filtering, 5 000 chips, 400 systems, 800
implementations (500 chip-level + 300 system-level cores), `machine_chip` at ~10 rows per machine.

`machine_chip` dominates: 140 000 rows of `(machine_id TEXT, mame_tag TEXT, chip_id TEXT, clock_hz INTEGER,
quantity INTEGER)`. In a `WITHOUT ROWID` B-tree each row is the record header plus the payload; with
9–10-character identifiers and a short tag that is roughly 7 + 10 + 10 + 11 + 5 + 2 ≈ **45 B/row → ~6.3 MB**,
plus `ix_machine_chip_chip` which repeats `chip_id` + the whole three-column PK at ~32 B/row → **~4.5 MB**.
Everything else — 14 000 machine rows with a name and sourcefile (~110 B each → 1.5 MB), 5 000 chips with a
description (~150 B → 0.8 MB), 28 000 unmapped-device rows (~1 MB + index), 12 000 implementation paths,
10 000 chip names and datasheets — adds ~6 MB. **Estimate: 17–18 MB raw**, and SQLite pages of short ASCII
identifiers compress hard, so 4–5× on gzip and a little better on brotli: **~4 MB gzip, ~3 MB brotli**.

### Measurement

`pipeline/src/spike/build-fixture-db.ts` builds exactly that database. It applies **`schemas/schema.sql`
whole** — the same file the loader applies, all 36 tables and all 21 views — so the schema under test is the
shipped one, not an extract from a document.

```
row counts: machine 14 000 · machine_chip 140 000 · chip 5 000 · system_chip 4 661
            implementation 800 · machine_unmapped_device 27 980 · mame_device 3 000
foreign_key_check violations: 0     integrity_check: ok
size  raw = 22.88 MiB   gzip -9 = 5.06 MiB   brotli -q 11 = 3.54 MiB
```

The estimate held to within its stated band on the high side. Largest B-trees (`dbstat`, MiB):

| object                       | size |
| ---------------------------- | ---- |
| `machine_chip`               | 5.15 |
| `ux_machine_chip_tag`        | 4.41 |
| `ix_machine_chip_chip`       | 4.41 |
| `machine`                    | 1.54 |
| `machine_unmapped_device`    | 0.92 |
| `ix_machine_unmapped_device` | 0.89 |
| `chip`                       | 0.79 |
| `ix_machine_sourcefile`      | 0.60 |
| everything else              | 4.17 |

An earlier revision of this ADR reported **17.65 MiB raw / 2.74 MiB brotli** for this fixture. That figure was
honestly measured, but of a different schema: it predates `ux_machine_chip_tag`, the partial unique index the
schema fix pass added on `machine_chip(machine_id, mame_tag)`. That one index is **4.41 MiB**, 84 % of the
5.23 MiB growth; the rest is fixture content the earlier generator did not produce (a 3 000-row `mame_device`
catalogue and its index, `machine_system` rows, and the `notes` citation the DDL now requires on every
`verified_against_hardware = 1` implementation). The measurement replaces the old one; the old one is not
re-stated anywhere as current.

Two honesty notes on the fixture. (1) Synthetic identifiers (`mach00000`, `chip-00000`) are the same length
as real ones (`sf2ce`, `ym2151`, `sega-315-5011`), and every text column is populated, so this is not an
optimistic fixture; real prose descriptions would push it up somewhat and real MAME shortnames are on average
shorter, so ±30 % is the honest band. (2) A first version of the generator drew each machine's chips uniformly
from all 5 000 chips, which produced **349 distinct chips per system** — machines that share a driver share a
board, so that is nonsense. The generator now draws from a 25-chip per-system pool with a 5 % global-outlier
rate, giving 32–56 (mean 42) distinct chips per system. This changed no file size but changed Q2's timing by
**7.7×**; see below.

### Verdict

**3.54 MiB brotli / 5.06 MiB gzip for the whole dataset.** That is one medium hero image. Range-paging
machinery — a custom VFS, a page-aligned layout, a server that honours `Range`, and an unmaintained wrapper —
would be bought at the price of an extra 400 KB of engine, a worse cold-query profile, and a dependency the
project has already banned. The maintainer called the dataset small; the measurement agrees. **Whole-file
download. HTTP-range paging is premature and is not adopted.**

Loading those 22.88 MiB into an engine is not itself a cost worth engineering around: **7.8 ms** for
sqlite-wasm (copy into the wasm heap plus `sqlite3_deserialize`) and **8.5 ms** for `sql.js`
(`new SQL.Database(bytes)`), measured below. The download dominates the load by three orders of magnitude.

## Verification: all three engines actually run our schema

**Every number in this section comes from one committed script:
`pipeline/src/spike/verify-browser-engines.ts`. Run `npx tsx pipeline/src/spike/verify-browser-engines.ts` and
it prints them.** It builds the fixture, then for each engine applies `schemas/schema.sql` whole to an empty
database, counts what `sqlite_master` ended up holding, executes every view, loads the prebuilt file the way
the browser will, and runs the canonical queries — hashing each full result set so agreement is checked on
values, not on row counts.

> **Correction.** A previous revision of this section reported browser-engine timings (sqlite-wasm 0.8 / 601 /
> 31.5 ms, sql.js 0.6 / 603 / 18.7 ms) and the claim that both engines had run the schema. **No artifact in
> the repository produced those figures** — neither package was installed at the time and the only spike used
> `node:sqlite`. They were unsupported and are withdrawn. Both packages are now installed as root
> devDependencies and the numbers below were measured against them. The `node:sqlite` column of the old table
> was genuine and reproduces.

### What each engine did with the whole schema

| engine                    | package       | `SELECT sqlite_version()` | objects created from `schemas/schema.sql` | views executed | `julianday()` |
| ------------------------- | ------------- | ------------------------- | ----------------------------------------- | -------------- | ------------- |
| `node:sqlite`             | node 24.15.0  | **3.51.3**                | 36 table · 21 view · 34 index             | 21 / 21        | 2745          |
| `@sqlite.org/sqlite-wasm` | 3.53.0-build1 | **3.53.0**                | 36 table · 21 view · 34 index             | 21 / 21        | 2745          |
| `sql.js`                  | 1.14.1        | **3.49.1**                | 36 table · 21 view · 34 index             | 21 / 21        | 2745          |

Read that middle column carefully: it is the **whole** DDL, not the 14-view extract an earlier revision
tested. `STRICT`, `WITHOUT ROWID`, both partial unique indexes (`ux_machine_chip_tag`,
`ux_implementation_path_top`), the expression index `ux_chip_equivalence_pair` on `MIN()/MAX()`, every GLOB
character-class CHECK, and all 21 views compiled on all three engines with no dialect concession.

"Views executed" is stronger than "views created": each of the 21 is run (`SELECT * FROM v LIMIT 1`), so a
view that parses but cannot execute would fail here. That closes the specific gap a reviewer flagged — the 11
coverage and quality views had never been run on a browser engine, and they hold the schema's only
`julianday()` call, in `v_quality_warning`'s `IMPL_STALE_REVIEW` branch.
**`julianday()` exists and is correct in both wasm builds:** all three engines answer
`julianday('2026-07-22') - julianday('2019-01-15')` = **2745**, and on the fixture
`SELECT code, COUNT(*) FROM v_quality_warning GROUP BY code` returns the identical two-row result on all
three (`IMPL_STALE_REVIEW` 414, `UNMAPPED_DEVICE_HIGH_IMPACT` 195) — 414 of those rows are `julianday()`
arithmetic over real data, not a one-off literal.

The browser load path, exactly as run:

```js
// @sqlite.org/sqlite-wasm
const bytes = new Uint8Array(await (await fetch('/site-data/bomsquad.sqlite')).arrayBuffer());
const p = sqlite3.wasm.allocFromTypedArray(bytes);
const db = new sqlite3.oo1.DB();
sqlite3.capi.sqlite3_deserialize(
  db.pointer,
  'main',
  p,
  bytes.byteLength,
  bytes.byteLength,
  sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE,
);
// → rc 0 (SQLITE_OK) on 23 986 176 bytes.

// sql.js
const db = new SQL.Database(bytes);
```

Loading the 22.88 MiB file: **7.8 ms** (sqlite-wasm) and **8.5 ms** (sql.js). `node:sqlite` has no
`deserialize()`, so its column below is the same file opened read-only (0.1 ms).

### Measured query timings (best of 5, warm, one desktop machine)

| query                                          | rows  | `node:sqlite` 3.51.3 | sqlite-wasm 3.53.0 | sql.js 3.49.1 |
| ---------------------------------------------- | ----- | -------------------- | ------------------ | ------------- |
| **Q1** system BOM + `fpga_hdl` impl counts     | 12    | 0.2 ms               | 0.6 ms             | 0.6 ms        |
| **Q2** `v_prospector`, platform `mister`       | 328   | 243.8 ms             | 441.8 ms           | 439.3 ms      |
| **Q4** `v_chip_gap`, `kind_id = 'fpga_hdl'`    | 4 486 | 18.7 ms              | 34.8 ms            | 28.3 ms       |
| **Q5** `v_system_coverage_by_kind`, one system | 1     | 83.0 ms              | 141.4 ms           | 139.2 ms      |
| **QW** `v_quality_warning`, grouped by code    | 2     | 142.3 ms             | 227.1 ms           | 226.3 ms      |

Every result set was hashed (FNV-1a over the JSON of every row) and compared: **identical rows and identical
values on every query on all three engines.** Not row counts alone — the values agree, including the `REAL`
`satisfied_share` column, on a 3.49.1 build and a 3.53.0 build.

Wasm costs roughly 1.6–3× native, and the two wasm engines are within 1 % of each other on Q2, Q5 and QW.
`sql.js` is 19 % faster on Q4 and identical on Q1. **Nothing in this table is an argument between the two
libraries**, and in particular nothing in it favours the one the decision picks.

> **Read the sub-millisecond digits as noise.** Run-to-run variance exceeds the difference between the two
> wasm engines on Q2, Q5, QW and the load timing — a re-run of the same committed script swapped their rank
> on Q2 (434.5 / 440.8 ms) and on load (8.0 / 7.6 ms). Only the order-of-magnitude gaps here are meaningful:
> native vs wasm, and Q2 vs everything else. A future rank flip is not a regression.

**Q2 is the finding, and it survives.** 0.44 s in the browser is perceptible. It is not the `CROSS JOIN`:
`EXPLAIN QUERY PLAN` opens with `MATERIALIZE v_system_coverage_by_kind` / `MATERIALIZE v_system_chip_coverage`
and, inside the second of those, `SCAN ik` — the kind filter is pushed into the outer aggregate
(`SEARCH ik USING PRIMARY KEY (kind_id=?)`) but not into the per-chip layer, so the per-chip coverage is built
for all three `implementation_kind` rows and two thirds of it is discarded. The materialisation itself is a
`GROUP BY` over `v_system_chip_effective`, itself a `UNION` with a correlated `NOT EXISTS` over the
140 000-row `machine_chip`, and it is the whole 244 ms natively. Q5 confirms the diagnosis from the other side:
asking for **one** system's coverage costs 83 ms native / 141 ms wasm, because the view is materialised in
full either way. It is also the query most sensitive to how much machines of one system share chips — the
7.7× swing noted above. This is a **T6.2/T6.3 concern, not a schema defect**: the Prospector page can afford
one 0.44 s query behind a spinner, and if it cannot, the fix is a build-time materialisation of
`v_system_coverage_by_kind` into a generated cache table (permissible — it is generated output, not a base
fact) or a covering index, decided with real data. Recorded here so it is not rediscovered.

Determinism was also checked, since the real builder will need it: two builds in one process produced
byte-identical files (`sha256 3409f7669477fa7e…`), printed by `build-fixture-db.ts`.

## Decision

**Use `@sqlite.org/sqlite-wasm`, load the whole `dist/bomsquad.sqlite` with one `fetch`, and open it in memory
via `sqlite3_deserialize`. No OPFS, no `SharedArrayBuffer`, no COOP/COEP, no range paging.**

**The measurement did not overturn the decision, and it removed the one reason that would have.** The old
table implied sqlite-wasm was as fast as sql.js on the strength of numbers nobody had taken; the real numbers
say the same thing, and now they exist. On the fixture the two are within 1 % on Q2, Q5 and QW, sql.js is
19 % faster on Q4, and neither engine failed anything.

`sql.js` is therefore the close second, and it is **175 KB smaller over the wire** (287 KB vs 462 KB brotli,
re-measured). It loses on three points that matter more than 175 KB against a 3.54 MiB database:

1. It is a third-party wrapper on a bundled SQLite that lags upstream — **3.49.1 vs 3.53.0, both read out of
   the running engine**. Our schema leans on `STRICT`, `WITHOUT ROWID`, partial and expression indexes and
   view-heavy SQL; being on the SQLite project's own build removes a whole class of "does this feature exist
   in that fork's SQLite" questions. Note what this is _not_: 3.49.1 ran every one of them (the spike had to
   hand-write four ambient type declarations for `sql.js`, but zero SQL concessions). It is a lag argument,
   not a capability argument, and it is worth 175 KB only because the lag will keep growing.
2. `@sqlite.org/sqlite-wasm` ships its own TypeScript types (`dist/index.d.mts`); `sql.js` needs
   `@types/sql.js`, a separately versioned community package.
3. It leaves a header-free upgrade path open: if we ever want to cache the database across visits,
   `opfs-sahpool` does that **without** COOP/COEP. Choosing `sql.js` would mean a library swap to get there.

`wa-sqlite` is rejected on supply chain (the npm name is a stale mirror labelled Proprietary; upstream does not
publish to npm). `sql.js-httpvfs` is rejected as unmaintained since 2022, and unnecessary at 3.54 MiB.

## Consequences

- **Dependency to install (site workspace only):** `@sqlite.org/sqlite-wasm@3.53.0-build1`. Nothing is added
  to `pipeline`; the build side uses Node 24.15.0's built-in `node:sqlite` (SQLite **3.51.3**, measured), which
  was sufficient for everything the spike needed — `better-sqlite3` is not required. Both browser engines are
  presently installed at the **repository root as devDependencies**, because ADR evidence that cannot be
  re-run is not evidence; only the winner moves into `site`.
- **Two static assets must be copied into the Angular build** (`sqlite3.wasm` alongside the ES module), and
  the wasm must be served as `application/wasm`.
- **`site/public/staticwebapp.config.json` needs three changes in Phase 7** (not made here):
  - `Content-Security-Policy`: `script-src 'self'` must become `script-src 'self' 'wasm-unsafe-eval'`, or
    Chromium refuses to compile the module. This is the one security-relevant consequence of the decision.
  - `mimeTypes`: add `".wasm": "application/wasm"`, and a type for the database file.
  - `navigationFallback.exclude` / `routes`: the database must be excluded from the SPA fallback and served
    `immutable` with a content hash in its path, exactly like the existing `/site-data/*` rule.
- **Compression is a deployment question, not a code question.** If Azure SWA does not negotiate `br`/`gzip`
  for the database's content type, publish `bomsquad.sqlite.gz` and inflate with `DecompressionStream('gzip')`
  (universally available; note there is no brotli `DecompressionStream`, which costs ~1 MiB versus serving
  brotli directly). Verify with `curl -H 'Accept-Encoding: br,gzip' -I` against the deployed URL before
  assuming either.
- **The whole database sits in the wasm heap** — **22.88 MiB** on the fixture, and the wasm heap must be able
  to grow to it. Both wasm engines did so without configuration, in 7.8 ms and 8.5 ms respectively. Fine on any
  current device; it is the number the revisit trigger watches, and it has moved.
- **`node:sqlite` is confirmed adequate for the build side.** `DatabaseSync`, `StatementSync.all/get/run`,
  named `:params`, `PRAGMA foreign_key_check`, `integrity_check`, `ANALYZE`, `VACUUM` and `dbstat` all work.
- Phase 7 owns the Angular integration. This ADR owns only the choice and its evidence.

## Revisit trigger

Re-open this decision when **any** of:

- the built `dist/bomsquad.sqlite` exceeds **32 MiB raw** (two-thirds of the 48 MiB budget in
  `docs/data-model.md` §4.3), **or**
- its brotli transfer size exceeds **8 MiB**, **or**
- median time-to-first-useful-render on a mid-range mobile device exceeds **3 s** on a cold cache.

The first two triggers have less headroom than they did: the fixture now measures **22.88 MiB raw** against a
32 MiB trigger (71 % of it) and **3.54 MiB brotli** against an 8 MiB trigger. The raw figure is the one to
watch, and 4.41 MiB of the growth was a single index — an index worth keeping, but the next one is not free.

The response is the escape hatch `docs/data-model.md` §4.3 already names — split `machine_chip` (and its
index and its partial unique index), which is 61 % of the file, into a second database fetched lazily only when a machine detail page is
opened. With `sqlite3_deserialize`'s schema-name argument this is `ATTACH ':memory:' AS bulk` followed by a
deserialize into `bulk`, keeping one engine and one query language. **The response is not a chunked JSON
format and not `sql.js-httpvfs`.**

## The spike

Two files, both throwaway scaffolding marked as such in their headers, both wired into nothing — the CLI
dispatches neither, no pipeline module imports either, and no test runs them. They write to a temporary
directory, never into the repository.

| file                                           | run it with                                            | produces                                                                                                                                                           |
| ---------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pipeline/src/spike/build-fixture-db.ts`       | `npx tsx pipeline/src/spike/build-fixture-db.ts`       | the fixture; row counts, `integrity_check`, the `dbstat` table, raw/gzip/brotli sizes, the sha256 determinism check                                                |
| `pipeline/src/spike/verify-browser-engines.ts` | `npx tsx pipeline/src/spike/verify-browser-engines.ts` | every engine number in §"Verification": bundled SQLite versions, object counts, views executed, load times, query timings, result-set hashes, engine payload sizes |

`verify-browser-engines.ts` imports the fixture builder, so the second command runs both. It also carries
`sql.js.d.ts`, four ambient declarations standing in for `@types/sql.js` so the spike does not add a
dependency to type a library the decision rejects.

**Every number in this ADR traces to one of those two scripts** — that is the point of them, and it is the
defect they were written to fix. Delete both once the real builder (T5.x) exists.
