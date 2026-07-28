# Consuming the dataset

BOM Squad publishes exactly one artifact: `dist/bomsquad.sqlite`. There is no proprietary format to parse, no
SDK to install, and no API server to depend on — it is a plain SQLite database file, and you query it with
whatever SQLite client you already have: Node's built-in `node:sqlite`, Python's built-in `sqlite3`, the
`sqlite3` command-line shell, DB Browser for SQLite, or any language's SQLite driver. This document is for
that outside consumer: someone who wants the data, not someone contributing to it (see
[`CONTRIBUTING.md`](../CONTRIBUTING.md) and [`docs/contributing-mappings.md`](contributing-mappings.md) for
that side).

## 1. What you're getting

One file, built by `pipeline build` (`docs/data-model.md` §4.3, §0.1) from the curated row files under `data/`
plus the MAME-derived row files under `extract/`:

- **36 tables, 21 views, 34 explicit indexes** — the exact counts `schemas/schema.sql`'s own header states,
  cross-checked against `sqlite_master` by the pipeline's own test suite, so this document and the shipped
  file cannot silently disagree. (Opening the file with `SELECT name FROM sqlite_master WHERE type='table'`
  turns up a 37th name, `sqlite_stat1` — that's SQLite's own statistics table, written by the build's `ANALYZE`
  step, not part of the 36-table schema; ignore it.)
- **STRICT, `WITHOUT ROWID` tables throughout.** This has no practical effect on read queries — you `SELECT`
  from them exactly like any other SQLite table — but it does mean column types are enforced at write time, so
  what you read back is exactly the declared type, never a stringly-typed surprise.
- **A hard size budget.** The database must not exceed 48 MiB (50,331,648 bytes) uncompressed
  (`docs/data-model.md` §4.3); the whole point is that a consumer — including the in-browser SPA — can fetch
  the entire file in one request rather than paginating a chunked format. The build actually shipping today is
  5.68 MiB.
- **Read-only, as far as you're concerned.** Nothing about the published file expects a consumer to write to
  it; open it read-only if your driver supports the option (both examples below do).

## 2. Getting the file

**Honesty check first: dataset releases are not published yet.** TASKS T6.6 ("Release publishing" — a
GitHub Action that publishes `dist/` as a date-tagged Release on merge to `main`) has not been built, and no
release workflow exists under `.github/workflows/` today (only CI and site deployment do). There is
therefore no download URL you can use right now — anything claiming otherwise would be fiction. This section
says plainly what's real today and what the future shape will be, and does not blur the two.

### 2.1 Today: build it yourself

`dist/bomsquad.sqlite` is fully reproducible from a clone of this repository — you do not need network access
to MAME's own data, because the MAME-derived row files (`extract/machine.json`, `extract/machine_chip.json`,
`extract/machine_unmapped_device.json`) are committed, not fetched at build time:

```
$ git clone https://github.com/mcfbytes/BomSquad.git
$ cd BomSquad && npm install
$ npm run build:db --workspace @bomsquad/pipeline
> @bomsquad/pipeline@0.0.0 build:db
> tsx src/cli.ts build

build: loaded 70263 rows from 315 row files
build: corrections applied to machine_chip — 0 removed, 0 added, 0 set (data-model.md §5.1)
build: /path/to/BomSquad/dist/bomsquad.sqlite
  dataset 2026-07-28 · MAME 0.288 · schema 2.0.0 · thresholds 2.0.0
  rows    70263 from 315 files
  counts  chip 169 · system 69 · machine 9775 · implementation 41 · project 19
  mapped  34566 of 62651 device instances (0.5517)
  devices 168 mapped · 183 ignored · 3527 unmapped
  size    5.68 MiB raw · 1.22 MiB brotli · ceiling 48.00 MiB
  sha256  fd97f89ef51883c86b82d509dbfdb821791d4cb2d613c9f10596cdedf6a2ea21
  wrote   /path/to/BomSquad/dist/quality-report.json
  wall clock 6.7s
```

That's `dist/bomsquad.sqlite`, ready to query, plus `dist/quality-report.json` — the small scalar health
summary described in §5, below. The build is deterministic: running it twice on the same inputs produces a
byte-identical file (`docs/data-model.md` §4.3), so there's no ambiguity about "which build" you have beyond
the `sha256` the log prints.

### 2.2 Once T6.6 ships: the shape a release will take

`dist/README.md` already documents the intended artifact set for a published release —
`bomsquad.sqlite`, `quality-report.json`, and a `bomsquad-<date>-release.tar.gz` bundling both — attached to a
GitHub Release on this repository, tagged with the same date-stamped `dataset_version` that
`docs/versioning.md` §2 specifies. **None of that exists today.** The example script in §3 is written so that
the download step is exactly the one line that changes once it does; everything after it — opening the file
and running a query — is real and works today against a locally built database.

## 3. A working example script

Below is a real, runnable script — tested against a database built with the exact command in §2.1 — that
shows the shape a "download a release and query it" workflow will take, and falls back honestly to a local
build today, since there is nothing yet to download.

```js
#!/usr/bin/env node
// query-prospector.mjs — fetch a BOM Squad release and query it.
//
// T6.6 (release publishing) has not shipped yet, so step 1 is written for the shape it
// WILL take once a dated GitHub Release exists, and falls back to a database you already
// built locally with `npm run build:db --workspace @bomsquad/pipeline`.
import { DatabaseSync } from 'node:sqlite';
import { createWriteStream, existsSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';

const LOCAL_DB = process.argv[2] ?? 'dist/bomsquad.sqlite';

// --- Step 1: get the file ------------------------------------------------------------
// Once T6.6 ships, the current dataset will be a dated GitHub Release on this repo, and
// this is the download this step will do:
//
//   const url = 'https://github.com/mcfbytes/BomSquad/releases/latest/download/bomsquad.sqlite';
//   const response = await fetch(url);
//   if (!response.ok) throw new Error(`download failed: ${response.status}`);
//   await pipeline(response.body, createWriteStream(LOCAL_DB));
//
// That release does not exist today (see docs/consuming-the-dataset.md §2). Until it
// does, build the file locally instead:
//   npm run build:db --workspace @bomsquad/pipeline
if (!existsSync(LOCAL_DB)) {
  throw new Error(
    `${LOCAL_DB} not found. Releases aren't published yet (T6.6) — build one locally: ` +
      `npm run build:db --workspace @bomsquad/pipeline`,
  );
}

// --- Step 2: query it -----------------------------------------------------------------
const db = new DatabaseSync(LOCAL_DB, { readOnly: true });

const { schema_version: schemaVersion } = db
  .prepare("SELECT value AS schema_version FROM dataset_meta WHERE key = 'schema_version'")
  .get();
const { user_version: userVersion } = db.prepare('PRAGMA user_version').get();
console.log(`schema ${schemaVersion}, PRAGMA user_version = ${userVersion}`);

const rows = db
  .prepare(
    `SELECT system_id, chips_total, chips_satisfied, satisfied_share
     FROM v_prospector
     WHERE platform_id = 'mister'
     ORDER BY satisfied_share ASC, chips_total DESC
     LIMIT 5`,
  )
  .all();
console.log('Boards on MiSTer with the least chip coverage so far:');
for (const row of rows) {
  console.log(
    `  ${row.system_id}: ${row.chips_satisfied}/${row.chips_total} (${row.satisfied_share})`,
  );
}
db.close();
```

Actually run, against the database built in §2.1:

```
$ node query-prospector.mjs dist/bomsquad.sqlite
schema 2.0.0, PRAGMA user_version = 2
Boards on MiSTer with the least chip coverage so far:
  konami-system-573: 0/11 (0)
  namco-system12: 0/6 (0)
  namco-system-nb1: 0/5 (0)
  namco-system11: 0/4 (0)
  sega-dreamcast: 0/4 (0)
```

`node:sqlite` ships unflagged in this project's pinned Node line (24.x, `.nvmrc`); on Node 22–23 it needs
`--experimental-sqlite`, and on anything older you'd reach for a third-party driver such as `better-sqlite3`
instead — the SQL and the file are identical either way.

**The same query in Python**, for a consumer who'd rather not touch Node — Python's `sqlite3` module needs no
install either:

```python
import sqlite3

con = sqlite3.connect("file:dist/bomsquad.sqlite?mode=ro", uri=True)
cur = con.cursor()
cur.execute(
    """
    SELECT system_id, chips_total, chips_satisfied, satisfied_share
    FROM v_prospector
    WHERE platform_id = 'mister'
    ORDER BY satisfied_share ASC, chips_total DESC
    LIMIT 5
    """
)
for row in cur.fetchall():
    print(row)
con.close()
```

Also actually run, against the same file:

```
$ python3 query.py
('konami-system-573', 11, 0, 0.0)
('namco-system12', 6, 0, 0.0)
('namco-system-nb1', 5, 0, 0.0)
('namco-system11', 4, 0, 0.0)
('sega-dreamcast', 4, 0, 0.0)
```

## 4. The stable query surface: query the views

**The 21 shipped views are the stable query surface of this dataset — query them, not the base tables,
whenever a view already answers your question.** The 36 base tables are the normalized row-level storage
`docs/data-model.md` specifies, and they're real, joinable, and fully documented there — nothing stops you
from querying them directly — but they are this project's implementation detail: they gain tables and columns
as curation grows (data-model.md's own change-control rule treats "adding a table" and "adding a nullable
column" as ordinary minor bumps), and a join you hand-write against them today can need a second join
tomorrow. The views exist specifically so that doesn't happen to you: each one answers one of the project's
canonical questions ("what does this board need," "what's missing," "is this dataset healthy") in one `SELECT`,
and a schema change that alters the underlying join updates the view, not your query. If you only remember one
rule from this document, make it this one.

All 21, by what they answer:

**Machine and system resolution**

| View                      | Answers                                                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `v_machine_system`        | Which `system_id` a machine belongs to (a `machine_system` row wins; else the `system_driver` rule for its source file; else no system). |
| `v_machine`               | A machine with `machine_correction` applied, year parsed to an integer, manufacturer resolved.                                           |
| `v_machine_bom`           | A machine's effective BOM: its own `machine_chip` rows, plus its system's `system_chip` rows for any chip it doesn't already have.       |
| `v_machine_instance`      | Per machine: mapped vs. unmapped device-instance counts.                                                                                 |
| `v_system_chip_effective` | A system's chip set: curated `system_chip` rows, plus chips MAME actually observed on its machines.                                      |
| `v_system_unmapped`       | Per system: how many distinct unmapped MAME devices its machines carry — the confidence signal.                                          |
| `v_system_instance`       | Per system: mapped vs. unmapped device-instance counts and the unmapped share.                                                           |
| `v_mame_device_worklist`  | Every unmapped MAME device, with machine and instance counts — the curation queue.                                                       |

**Coverage — "does an implementation exist for this chip?"**

| View                          | Answers                                                                                                                                             |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v_chip_satisfies`            | Raw substitution edges: a chip satisfies itself, both directions of every `equivalent` pair, and one direction of every `provides` pair.            |
| `v_chip_satisfied`            | The same, joined against actual implementations, so it's per `kind_id` (`fpga_hdl`, `software_emulation`, `original_silicon`, ...).                 |
| `v_chip_evidence`             | Per (kind, chip): the best evidence available — direct/equivalent/provides — and a confidence label.                                                |
| `v_chip_implementation_count` | How many implementations exist per (chip, kind).                                                                                                    |
| `v_system_chip_coverage`      | Per (kind, system, chip): whether it's satisfied, by what evidence, and by which provider chip.                                                     |
| `v_system_coverage_by_kind`   | Per (kind, system): chips total/direct/equivalent/provided/satisfied, `satisfied_share`, and a confidence label — **the headline coverage number.** |
| `v_system_core`               | (kind, system, platform) triples that already have a system-level implementation.                                                                   |
| `v_prospector`                | Systems × FPGA platforms with **no** core yet, ranked by coverage and confidence — the Prospector.                                                  |
| `v_chip_gap`                  | Chips with no implementation of a given kind, with system/machine usage counts — coverage read backwards.                                           |

**Dataset health**

| View                     | Answers                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `v_quality_instance`     | Dataset-wide: total mapped vs. unmapped device instances, and the mapped-instance share.                                              |
| `v_quality_device`       | Dataset-wide: how many MAME devices are mapped, ignored, or unmapped.                                                                 |
| `v_quality_completeness` | Per (entity, optional column): how many rows have it populated — e.g. how many chips have a `manufacturer_id`.                        |
| `v_quality_warning`      | Every WARN-level finding as one row (`code`, `subject`, `impact`, `detail`) against the closed registry in `docs/data-quality.md` §4. |

All 21 are defined verbatim in `schemas/schema.sql` (§6–8 of that file) and specified in
`docs/data-model.md` Appendix B, `docs/coverage.md` §3.4, and `docs/data-quality.md` Appendix Q respectively —
read those if you want the exact SQL rather than the one-line gloss above. One caveat worth knowing before you
sort by it: `v_quality_warning.impact` mixes `INTEGER`, `REAL`, and `NULL` across different warning codes
(views aren't `STRICT`), so treat it as "a number, or nothing" and never sort or compare it across codes.

## 5. Versioning

A published database carries **four independent version facts**, each answering a different question,
specified in full in [`docs/versioning.md`](versioning.md) — this section is the consumer-facing summary and
must not (and does not) disagree with it. Read straight from a build:

```
$ node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('dist/bomsquad.sqlite', { readOnly: true });
console.log('PRAGMA user_version:', db.prepare('PRAGMA user_version').get().user_version);
for (const row of db.prepare('SELECT key, value FROM dataset_meta ORDER BY key').all()) {
  console.log(row.key, '=', row.value);
}
"
PRAGMA user_version: 2
build_date = 2026-07-28
dataset_version = 2026-07-28
mame_version = 0.288
schema_version = 2.0.0
threshold_version = 2.0.0
```

| Fact                  | Where                                                                                           | Format                        | Question it answers                                       |
| --------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------- |
| **Schema version**    | `PRAGMA user_version` (major only, integer) **and** `dataset_meta.schema_version` (full semver) | `MAJOR.MINOR.PATCH`           | What shape is the database?                               |
| **Dataset version**   | `dataset_meta.dataset_version`                                                                  | `YYYY-MM-DD`, optionally `.N` | Which content snapshot was this built from?               |
| **MAME version**      | `dataset_meta.mame_version`                                                                     | MAME's own string (`0.288`)   | Which MAME release did extraction run against?            |
| **Threshold version** | `dataset_meta.threshold_version`                                                                | semver                        | Which quality-policy config produced this report's WARNs? |

None of the four is derivable from another — a curation-only release can bump `dataset_version` with
`schema_version` unchanged, and vice versa. Two places carry the schema version on purpose, and they answer
different questions, not the same one twice: `PRAGMA user_version` is a **generic SQLite mechanism** — any
SQLite client can read it without knowing a thing about this project's schema, which is what makes it the
right place for "is this file even structurally compatible with code built against it," and it can only ever
hold an integer, hence major-only. `dataset_meta.schema_version` is this project's own, fuller statement, and
is what `dist/quality-report.json` echoes for a human or a UI to display. `pipeline/src/db/schema.ts` is the
normative source for both:

```ts
export const SCHEMA_VERSION = '2.0.0';
export const SCHEMA_USER_VERSION = 2; // written into schema.sql as PRAGMA user_version = 2
```

**Bump rules**, if you need to reason about compatibility across two databases: adding a table, a nullable
column, a view, or a lookup row is a **minor** schema bump; changing a primary key, an `ON DELETE` behaviour,
making a column `NOT NULL`, removing anything, or changing what a `CHECK` value means is a **major** bump.
`docs/versioning.md` §1.2 and §5 have the full rule and the migration log; nothing in this document overrides
either.

`dist/quality-report.json` (built alongside the database, `docs/data-quality.md` §8) carries the same four
version strings plus a handful of scalar counts and a `warnings_by_code` map — it's worth fetching alongside
the database if you want a cheap, single-file health summary without opening SQLite at all:

```json
{
  "counts": { "chip": 169, "implementation": 41, "machine": 9775, "project": 19, "system": 69 },
  "dataset_version": "2026-07-28",
  "db_bytes": 5951488,
  "devices": { "ignored": 183, "mapped": 168, "unmapped": 3527 },
  "instances": {
    "mapped": 34566,
    "mapped_instance_share": 0.5517,
    "total": 62651,
    "unmapped": 28085
  },
  "mame_version": "0.288",
  "schema_version": "2.0.0",
  "threshold_version": "2.0.0",
  "warnings_by_code": { "CHIP_MANUFACTURER_FAMILY_MISMATCH": 9, "...": "..." }
}
```

(Genuine output from the same build as everywhere else in this document, `warnings_by_code` truncated for
space — the real file has ten keys today.)

## 6. Practical notes

- **Dialect.** `schemas/schema.sql`'s own header states the floor: SQLite ≥ 3.44. It's been verified against
  `node:sqlite` (3.51.3) and `@sqlite.org/sqlite-wasm` (3.53.0, what the site itself uses in-browser —
  `docs/adr/0001-browser-database.md`). Nothing in the schema is engine-specific — `STRICT` (3.37+),
  `WITHOUT ROWID` (3.8.2+), partial and expression indexes (3.8.0+/3.9.0+) are all long-stable SQLite features
  — so any reasonably current SQLite build reads the file correctly.
- **Open read-only if you can.** Neither example above writes to the database, and both open with a read-only
  flag/URI (`readOnly: true` for `node:sqlite`, `?mode=ro` for Python's URI form). Nothing stops a write, but
  nothing in this dataset expects one — it's a published, immutable snapshot.
- **`NULL` means "unknown," consistently.** A curated row never writes `null` in its source JSON
  (`docs/data-model.md` §4.3), but a column left unset **is** `NULL` once it lands in the database — a chip
  with no known `manufacturer_id` really does read back as SQL `NULL`. There's no sentinel value anywhere in
  this schema (empty string, `0`, `"unknown"`) standing in for "not known"; `NULL` always does that job.
- **Ignore `sqlite_stat1`.** It's SQLite's own query-planner statistics table, written by the build's
  `ANALYZE` step (data-model.md §4.3), and shows up in `sqlite_master` alongside the 36 real tables. It's not
  part of the schema this document or `docs/data-model.md` describes.

## 7. A few more canonical queries

`docs/data-model.md` §6 states five canonical queries the schema exists to answer; each is run here for real
against the same build as the rest of this document, to show the views in §4 actually working together.

**Every chip on Out Run hardware, and how many `fpga_hdl` implementations satisfy each:**

```
$ node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('dist/bomsquad.sqlite', { readOnly: true });
const rows = db.prepare(\`
  SELECT sc.chip_id, sc.role_id,
         COALESCE(cic.implementation_count, 0) AS fpga_implementations
  FROM system_chip sc
  LEFT JOIN v_chip_implementation_count cic
    ON cic.chip_id = sc.chip_id AND cic.kind_id = 'fpga_hdl'
  WHERE sc.system_id = 'sega-outrun'
  ORDER BY sc.role_id
\`).all();
console.log(rows);
"
```

```
[
  { chip_id: 'z80', role_id: 'audiocpu', fpga_implementations: 3 },
  { chip_id: 'i8255', role_id: 'io', fpga_implementations: 1 },
  { chip_id: 'm68000', role_id: 'maincpu', fpga_implementations: 3 },
  { chip_id: 'ym2151', role_id: 'sound', fpga_implementations: 2 },
  { chip_id: 'm68000', role_id: 'subcpu', fpga_implementations: 3 }
]
```

**Chips with no `fpga_hdl` implementation at all, ranked by how many systems use them:**

```
$ node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('dist/bomsquad.sqlite', { readOnly: true });
console.log(db.prepare(\`
  SELECT chip_id, display_name, function_id, system_count, machine_count
  FROM v_chip_gap
  WHERE kind_id = 'fpga_hdl'
  ORDER BY system_count DESC, machine_count DESC
  LIMIT 5
\`).all());
"
```

```
[
  { chip_id: 'dac-8bit-r2r', display_name: '8-bit R-2R DAC', function_id: 'sound-dac', system_count: 9, machine_count: 359 },
  { chip_id: 'sega-315-5296', display_name: 'Sega 315-5296', function_id: 'io', system_count: 7, machine_count: 91 },
  { chip_id: 'i8259a', display_name: 'Intel 8259A', function_id: 'io', system_count: 6, machine_count: 311 },
  { chip_id: 'sega-315-5313', display_name: 'Sega 315-5313', function_id: 'video-ppu', system_count: 6, machine_count: 161 },
  { chip_id: 'rp2a03g', display_name: 'RP2A03G', function_id: 'cpu', system_count: 4, machine_count: 88 }
]
```

Notice `z80`, `m68000` and `ym2151` don't show up here at all, even though they're heavily used
(§7's first query just showed `fpga_implementations` for three of them on Out Run alone) — `v_chip_gap` only
lists chips where **no** `fpga_hdl` implementation satisfies them by any evidence rank, so a well-covered chip
is correctly absent, not zero-ranked. What's left is the real gap list: a jellybean DAC and a run of
Sega/Konami/Nintendo customs and support chips nobody's written a core for yet.

**MiSTer boards with `medium`-confidence coverage but no core yet (`v_prospector` again, filtered instead of
sorted the other way from §3):**

```
$ node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('dist/bomsquad.sqlite', { readOnly: true });
console.log(db.prepare(\`
  SELECT system_id, chips_total, chips_satisfied, satisfied_share, confidence
  FROM v_prospector
  WHERE platform_id = 'mister' AND confidence = 'medium'
  ORDER BY satisfied_share DESC, chips_total DESC
  LIMIT 3
\`).all());
"
```

```
[
  { system_id: 'capcom-cps1', chips_total: 5, chips_satisfied: 5, satisfied_share: 1, confidence: 'medium' },
  { system_id: 'cave-68000', chips_total: 8, chips_satisfied: 6, satisfied_share: 0.75, confidence: 'medium' },
  { system_id: 'sega-systemc2', chips_total: 7, chips_satisfied: 5, satisfied_share: 0.7142857142857143, confidence: 'medium' }
]
```

Every query above is copy-pasteable against a database built per §2.1 — none of it is hypothetical.
