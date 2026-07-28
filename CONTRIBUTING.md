# Contributing to BOM Squad

BOM Squad is a curated database, not just a codebase. Most contributions are **data PRs**: a JSON file (or a
small edit to one) under `data/`, reviewed like code because it's validated like code. This guide covers every
contribution type with a copy-pasteable worked example, the formatting rules a hand-written file must satisfy,
and what `npm run validate` actually checks.

Read this before your first PR; it is shorter than getting a review comment back for each rule individually.

## 0. The map

- [`README.md`](README.md) — architecture and the curated/generated/build-output split.
- [`docs/data-model.md`](docs/data-model.md) — the normative schema: every table, key, and the on-disk file
  format (§4). This document quotes it in several places; where the two disagree, `data-model.md` wins.
- [`docs/taxonomy.md`](docs/taxonomy.md) — how to classify a chip's `function_id`.
- [`docs/coverage.md`](docs/coverage.md) — what `chip_equivalence` rows mean.
- [`docs/data-quality.md`](docs/data-quality.md) — the FAIL/WARN model `npm run validate` implements.
- [`schemas/README.md`](schemas/README.md) — the JSON Schema / DDL relationship.
- `data/README.md` and the README in each `data/` subdirectory — the file map and edit policy for that
  directory specifically. If this guide and a directory README disagree on a mechanical detail, the directory
  README is more current.

**Standing rules** (from [`TASKS.md`](TASKS.md), and load-bearing for everything below):

1. **Generated ≠ curated.** Never hand-edit anything under `extract/` or `dist/`. `extract/` is regenerated
   wholesale from the pinned MAME release, and `dist/bomsquad.sqlite` is a build output; a hand-edit to either
   is silently discarded the next time the pipeline runs. Fixes to generated data are curated correction rows
   (§6.5, below) — the only mechanism that survives a re-run.
2. **Determinism.** Every file the pipeline touches is byte-identical given the same inputs. For curated files,
   that means the canonical formatting in §2, below — not a style preference.
3. **No guessed facts.** Every curated fact (a chip's manufacturer, an implementation's license, a machine's
   corrected year) must be verifiable. Cite the source in the record's `notes` field or the commit message.
   **Omit a field you can't verify — do not guess.** An absent value is honest; a wrong one poisons every query
   run against it. This is the single most important rule in this document.
4. **Validate before commit.** Anything written under `data/` must pass `pipeline validate` locally — §3,
   below.
5. **Stable IDs.** Never rename a slug once it has appeared in a published dataset. If a slug is wrong, add a
   new row under the correct id, re-point every reference to it in the same PR, and retire the old id as an
   alias (§6.4).

## 1. Setup

Requires Node 24 (`.nvmrc`) and npm 11.

```sh
git clone https://github.com/mcfbytes/BomSquad.git
cd BomSquad
npm install
npm run validate
```

A clean checkout validates with zero errors. **You do not need to build the database to contribute data.**
`npm run validate` reads the row files under `data/` and `extract/` directly, so a data PR is complete the
moment it validates.

If you do want the whole artifact — to query the dataset, or to check that your rows land the way you expect —
`npm run build:db --workspace @bomsquad/pipeline` writes `dist/bomsquad.sqlite` and `dist/quality-report.json`
in a few seconds from what is already committed. (Note that the root `npm run build` is not this: it runs
`tsc` in each workspace. The database has its own command.) Rebuilding the MAME extract from scratch is a
separate, slower path — `npm run mame:fetch` then `mame:extract` then `mame:rows` — and is only needed when
the pinned MAME release changes, which the monthly refresh workflow handles.

## 2. The file format, exactly

A curated file is a JSON object whose top-level keys are **table names**, each mapping to an array of flat row
objects — never a nested document, never a field named as a key (data-model.md §4.1). Every rule below is
mechanically enforced by `npm run validate`; getting it right the first time just saves a round trip.

- **UTF-8, no BOM, `\n` newlines, exactly one trailing newline, two-space indentation** — precisely
  `JSON.stringify(value, null, 2)` plus a trailing `\n`. No comments, no trailing commas (this is strict JSON,
  unlike the illustrative `jsonc` snippets in data-model.md). Non-ASCII characters are written verbatim, not
  escaped.
- **Top-level key order:** the file's entity table first (if it has one — `chip`, `system`, `project`,
  `implementation`), then every other table name **bytewise ascending**.
- **Row key order:** each row's keys follow the table's column order in `schemas/schema.sql` — not the order
  you happened to type them, and not alphabetical.
- **Row order within an array:** sorted bytewise ascending by the table's primary-key columns, in the order
  they're declared in the DDL.
- **Omit `NULL` columns entirely.** Never write `"field": null` — there is no field in this model where `null`
  is a meaningful value to write; "unknown" is spelled by leaving the key out.
- **Filename stem = entity key.** For a per-entity file (`data/chip/<id>.json`, `data/system/<id>.json`, etc.)
  the filename stem must equal that file's one entity row's primary key, and every row in the file must carry
  that same key. `data/chip/ym2151.json` must contain a `chip` row whose `chip_id` is `"ym2151"` — nothing
  else.
- **Slug grammar** (data-model.md §3.2), for every `chip_id`, `system_id`, `project_id`, `implementation_id`,
  and lookup-table key except `license_id`:

  ```
  ^[a-z0-9]+(?:-[a-z0-9]+)*$        1–64 characters, lowercase ASCII, hyphen-separated, no leading/
                                     trailing/doubled hyphen
  ```

  `license_id` instead follows SPDX syntax (or the literal string `custom`); MAME-derived keys
  (`machine_id`, `mame_device`, `mame_sourcefile`, `mame_tag`) follow MAME's own grammar, not this one — you
  won't be minting those by hand except inside a correction row, where they must match an existing MAME value
  exactly.

If you'd rather see this in code than prose: [`pipeline/src/validate/rules.ts`](pipeline/src/validate/rules.ts)
is the literal implementation of every rule above (`filename-key`, `table-key-order`, `row-key-order`,
`row-order`, `json-format`), and its module docstring explains why each one exists.

## 3. Running the validator

```sh
npm run validate                                        # human-readable report, from the repo root
npm run validate --workspace pipeline -- --strict       # warnings also fail (aim for this locally)
npm run validate --workspace pipeline -- --json         # machine-readable, same diagnostics
```

The root `validate` script doesn't forward extra flags (`npm run validate -- --strict` from the repo root
silently drops `--strict` — npm's own arg parsing swallows it before it reaches the pipeline's CLI). Use
`--workspace pipeline --` as above, or `cd pipeline && npm run validate -- --strict`, to actually pass a flag
through.

`pipeline validate` (`pipeline/src/validate/index.ts`) runs three independent layers over everything under
`data/` and `extract/`:

1. **Shape** — every row file validated against `schemas/rowfile.schema.json` with ajv: JSON structure, column
   names, types, string grammars, required columns.
2. **The database** — every row loaded into a fresh in-memory SQLite database built from `schemas/schema.sql`.
   `PRIMARY KEY`, `UNIQUE`, `CHECK`, `NOT NULL`, and `PRAGMA foreign_key_check` do the referential and
   constraint checking — nothing here is a hand-written duplicate of a database constraint.
3. **Lint** — the handful of rules a database can't express (filename↔key, canonical JSON form — §2, above),
   plus the WARN codes of [`docs/data-quality.md`](docs/data-quality.md) §4, read from the shipped view
   `v_quality_warning` rather than re-implemented.

Every diagnostic names the file, the offending row's key, the offending column, and a concrete fix. Three real
examples, captured by actually running the validator against fixture data shaped like the worked examples
below:

**A required column left out** (forgetting `function_id` when adding a chip — two layers catch it
independently, which is expected, not a bug):

```
ERROR chip/ym2151.json: chip[ym2151].function_id [not-null-violation] function_id is required but missing
      fix: add "function_id" to this row — it is NOT NULL in schemas/schema.sql
ERROR chip/ym2151.json: chip[ym2151].function_id [schema-shape] must have required property 'function_id' (required)
      fix: add the required column 'function_id' to this chip row
```

**A foreign key that doesn't resolve** (a typo'd `manufacturer_id`):

```
ERROR chip/ym2151.json: chip[ym2151].manufacturer_id [foreign-key-violation] manufacturer_id='yamaha-corporation' has no matching manufacturer.manufacturer_id row
      fix: add the missing manufacturer row, or change manufacturer_id to an existing manufacturer.manufacturer_id value
```

**A WARN, which does not fail the build** (an implementation with no verified license or accuracy — see §6.3;
this is the _correct_, honest state for a row you haven't finished researching yet):

```
WARN implementation/jt51.json: implementation[jt51].accuracy_id [impl-unverified-accuracy] implementation has no assessed accuracy level
      fix: set accuracy_id to an accuracy_level key once the implementation has been assessed
WARN implementation/jt51.json: implementation[jt51].license_id [impl-unverified-license] implementation has no verified license
      fix: read the repository's LICENSE file and set license_id to the matching data/lookup/license.json key
```

Exit codes: `0` clean (or warnings only), `1` at least one ERROR (or any WARN under `--strict`).

**CI.** There is no separate `pipeline validate` CI step; instead, the `pipeline` job (`.github/workflows/ci.yml`)
runs `npm run test --workspace @bomsquad/pipeline`, whose suite includes a test that calls the same `validate()`
function against the real `data/` tree and asserts zero errors. That job's path filter includes `data/**` and
`schemas/**`, so a pure data PR still triggers it. Run `npm run validate` locally before you push — CI runs the
identical code, just wrapped in a test assertion.

## 4. Standing rule 3 in practice: cite everything

Every non-obvious fact needs a paper trail: a datasheet URL in `chip_datasheet`, a citation in a `notes` field,
or a link in the commit message. Two fields are schema-enforced citations, not a style suggestion:

- `chip_equivalence.note` is `NOT NULL` — every equivalence edge requires a justification (docs/coverage.md).
- `implementation.notes` is required whenever `verified_against_hardware = 1` (schema `CHECK`).

When you don't know something, **omit the field**. A `WARN` in `npm run validate` for a missing
`manufacturer_id`, `description`, `license_id`, or `accuracy_id` is the system working as intended — it is
visible, queryable, and honest. A guessed value that happens to validate is worse than any warning, because
nothing will ever flag it.

## 5. Add a lookup value

A new manufacturer, FPGA platform, license, accuracy level, HDL language, chip role, chip family, or system
kind is **a pure data change, not a schema change** (data-model.md §0.2: "a value set gets its own table when
adding a member is a pure data change"). Edit the one file for that table under `data/lookup/`, add your row
in the position bytewise-sorted by its key, with columns in DDL order.

```jsonc
// data/lookup/manufacturer.json — adding one row (existing rows omitted for brevity)
{
  "manufacturer": [
    // ... existing rows, bytewise ascending by manufacturer_id ...
    {
      "manufacturer_id": "ensoniq",
      "name": "Ensoniq",
      "country": "US",
    },
    // ... remaining rows ...
  ],
}
```

`country` is ISO 3166-1 alpha-2; omit it, or `notes`, rather than guess (Standing rule 3).

**One exception:** adding a `chip_function` value additionally requires a new §4 section in
[`docs/taxonomy.md`](docs/taxonomy.md) in the _same_ PR — that document is normative over the taxonomy's
seed data and the two must agree in both directions (taxonomy.md §7, "change control"). You will not need to
do this often; the 26 seeded values already cover the MVP chip catalog.

## 6. The four data contribution types

### 6.1 Add a chip

One file, `data/chip/<chip_id>.json`, bundling `chip` plus its optional `chip_name` (alternate names / retired
ids) and `chip_datasheet` rows (data-model.md §4.2).

`data/chip/ym2151.json`:

<!-- prettier-ignore -->
```json
{
  "chip": [
    {
      "chip_id": "ym2151",
      "display_name": "YM2151",
      "function_id": "sound-fm",
      "manufacturer_id": "yamaha",
      "family_id": "opm",
      "description": "Eight-channel, four-operator FM synthesizer (OPM).",
      "typical_clock_hz": 3579545,
      "package": "DIP-24",
      "year_introduced": 1984
    }
  ]
}
```

A chip with an alternate name and a datasheet link adds two more arrays, both keyed by `chip_id` in the same
file, sorted after `chip` (top-level key order is the entity table first, then the rest bytewise ascending —
`chip_datasheet` before `chip_name`):

`data/chip/m68000.json`:

<!-- prettier-ignore -->
```json
{
  "chip": [
    {
      "chip_id": "m68000",
      "display_name": "MC68000",
      "function_id": "cpu",
      "manufacturer_id": "motorola",
      "description": "16/32-bit CISC processor with a 24-bit address bus.",
      "year_introduced": 1979
    }
  ],
  "chip_datasheet": [
    {
      "chip_id": "m68000",
      "url": "https://www.nxp.com/docs/en/data-sheet/MC68000UM.pdf",
      "title": "MC68000 8-/16-/32-Bit Microprocessors User's Manual"
    }
  ],
  "chip_name": [
    {
      "chip_id": "m68000",
      "name": "MC68000P10",
      "kind": "alias"
    }
  ]
}
```

**Picking `function_id`.** Read [`docs/taxonomy.md`](docs/taxonomy.md) §2 (the tie-break rules, applied in
order) and §3 (the decision guide — a literal ordered list of yes/no questions). §6 has 20 worked adjudications
for parts that look ambiguous at first glance (a CPU with a sound generator on-die is still `cpu`; an ASIC
spanning video and protection with no dominant function is `custom`). If the part's function is genuinely
unknown to you, the honest answer is **no chip row at all** — leave the MAME device unmapped rather than filing
a guess (taxonomy.md TB8).

**`manufacturer_id` and `family_id` must already exist as lookup rows** in `data/lookup/manufacturer.json` and
`data/lookup/chip_family.json` respectively — `yamaha` and `opm` already do, as does `motorola`, so both
examples above validate as-is against a fresh checkout. If the chip you're adding needs a manufacturer or
family that doesn't exist yet, add it first (§5) — in the same PR is fine.

Standing rule 3 applies to every nullable column: `manufacturer_id`, `family_id`, `model`, `typical_clock_hz`,
`package`, and `year_introduced` are all nullable specifically so you can omit what you can't verify.
`function_id` is the one required fact — every chip classifies into exactly one value, no exceptions.

Never rename `chip_id` once it ships (Standing rule 5); see §6.4 for the alias mechanism if you get one wrong.

### 6.2 Add a system

One file, `data/system/<system_id>.json`, bundling `system`, `system_name`, `system_driver` (bulk membership by
MAME driver source file), and `system_chip` (the curated BOM). This example is the same System 16A board
data-model.md §4.1 uses as its own worked example — reproduced here in exact byte-canonical form (that
document's version is written as illustrative `jsonc`, with a comment and non-canonical key order; this is
what actually passes `npm run validate`):

`data/system/sega-system16a.json`:

<!-- prettier-ignore -->
```json
{
  "system": [
    {
      "system_id": "sega-system16a",
      "name": "Sega System 16A",
      "kind_id": "arcade",
      "manufacturer_id": "sega",
      "year_introduced": 1985,
      "description": "Sega's first System 16 arcade board revision."
    }
  ],
  "system_chip": [
    {
      "system_id": "sega-system16a",
      "role_id": "audiocpu",
      "chip_id": "z80",
      "clock_hz": 4000000
    },
    {
      "system_id": "sega-system16a",
      "role_id": "maincpu",
      "chip_id": "m68000",
      "clock_hz": 10000000
    },
    {
      "system_id": "sega-system16a",
      "role_id": "sound",
      "chip_id": "ym2151",
      "clock_hz": 4000000
    }
  ],
  "system_driver": [
    {
      "mame_sourcefile": "sega/segas16a.cpp",
      "system_id": "sega-system16a"
    }
  ],
  "system_name": [
    {
      "system_id": "sega-system16a",
      "name": "System 16A",
      "kind": "alias"
    }
  ]
}
```

Notes on the shape:

- `system_chip`'s key is `(system_id, role_id, chip_id)` — a curated board position (`chip_role`, see
  `data/lookup/chip_role.json`) plus the part filling it, with `clock_hz` as actually fitted on this board (it
  can differ from the chip's `typical_clock_hz`). `quantity` defaults to 1 and only collapses genuinely
  identical parts in the same role.
- Every `chip_id` referenced (`z80`, `m68000`, `ym2151` here) must already exist under `data/chip/` — a new
  system's PR commonly adds its chips in the same PR if they aren't cataloged yet.
- `system_driver.mame_sourcefile` is keyed **alone**, not by `(system_id, sourcefile)`: it states "unless
  something says otherwise, every machine in this driver file defaults to this system." When one driver file
  genuinely hosts more than one system (`sega/segas16b.cpp` also carries System 16C, for instance), the
  per-machine exception is a `machine_system` row — that lives in `data/correction/machine.json`, not here,
  because it's keyed by `machine_id` rather than by a single system (§6.5).
- `kind_id` must resolve into `data/lookup/system_kind.json` (`arcade`, `console`, `computer`, `handheld`,
  `pinball`, `other`); there is no separate "platform family" table — `system` **is** that concept
  (data-model.md §1.9).

### 6.3 Add an implementation

One file, `data/implementation/<implementation_id>.json`. **There is no `core` table.** A MiSTer core is just
an `implementation` row with `kind_id = 'fpga_hdl'` plus a row in `implementation_system` targeting the board
it covers (data-model.md §1.4). The same table also holds software emulators (`kind_id = 'software_emulation'`)
and the physical part itself (`kind_id = 'original_silicon'`).

A chip-level implementation — an HDL core of one chip, not yet wired to a whole system:

`data/implementation/jt51.json`:

<!-- prettier-ignore -->
```json
{
  "implementation": [
    {
      "implementation_id": "jt51",
      "name": "JT51",
      "kind_id": "fpga_hdl",
      "project_id": "jotego",
      "repo_url": "https://github.com/jotego/jt51",
      "hdl_language_id": "verilog"
    }
  ],
  "implementation_chip": [
    {
      "implementation_id": "jt51",
      "chip_id": "ym2151"
    }
  ]
}
```

This validates cleanly but produces the two WARNs shown in §3 — `IMPL_UNVERIFIED_LICENSE` and
`IMPL_UNVERIFIED_ACCURACY` — because `license_id` and `accuracy_id` are left out. **That is correct, not a
mistake to fix by guessing.** `license_id` MUST be read from the repository's own `LICENSE` file, never
inferred from a README, a project's general reputation, or another implementation from the same author —
different repos under one project can carry different licenses. Once you've actually opened the file and
confirmed which SPDX id it is, set `license_id` to a key from `data/lookup/license.json` (adding one there
first if it's genuinely missing — an SPDX id you can name is a pure data change, §5). Likewise, only set
`accuracy_id` once you have actually assessed the core's fidelity against `data/lookup/accuracy_level.json`'s
definitions.

To make a **core** — the same implementation targeting a whole system — add an `implementation_system` row:

`data/implementation/mister-arcade-outrun.json`:

<!-- prettier-ignore -->
```json
{
  "implementation": [
    {
      "implementation_id": "mister-arcade-outrun",
      "name": "Out Run (MiSTer)",
      "kind_id": "fpga_hdl",
      "hdl_language_id": "verilog"
    }
  ],
  "implementation_system": [
    {
      "implementation_id": "mister-arcade-outrun",
      "system_id": "sega-outrun-hw"
    }
  ]
}
```

(`sega-outrun-hw` is illustrative — Out Run hardware isn't cataloged under `data/system/` in this checkout yet.
The point being demonstrated is the `implementation_system` row, not this specific board; add the `system`
file first, as in §6.2, if you're targeting a system that doesn't exist yet.)

No schema change, no new table — `implementation_system` is exactly what makes an `implementation` a "core."
Other tables in the same file when applicable: `implementation_path` (repo-relative source paths, with at most
one `is_top = 1`), `implementation_platform` (target FPGA platforms, from `data/lookup/fpga_platform.json`),
`implementation_machine` (specific MAME machines it runs), and `implementation_dependency` (other
implementations it consumes, e.g. a core that embeds `jt51` for its sound chip — self-referencing, so a core
may consume a core). There is no `known_consumers` field to maintain by hand; it's `implementation_dependency`
read backwards.

`kind_id = 'original_silicon'` is the one kind that carries none of `repo_url`, `hdl_language_id`,
`license_id`, or `accuracy_id` — the part as manufactured isn't a codebase, and the schema's `CHECK` rejects
those fields on that kind rather than silently ignoring them.

### 6.4 Renaming a slug (the alias mechanism)

You will not do this often — Standing rule 5 says never rename a shipped id — but if a `chip_id` or
`system_id` turns out to be wrong before it's fixed for good, the mechanism is `chip_name` / `system_name`
(data-model.md §3.4), never an in-place rename:

1. Add the new row under the corrected id.
2. Re-point every reference to the old id, in the same PR (`PRAGMA foreign_key_check` fails the build until
   this is complete — it's mechanical, not something you have to track by hand).
3. Retire the old id: `{ "chip_id": "<new_id>", "name": "<old_id>", "kind": "retired_id" }` in the new chip's
   `chip_name` array (or `system_name` for a system). This is the _only_ alias mechanism — there is no separate
   `aliases.json` file.

A `kind: "alias"` row (as in the `m68000` / `mc68000p10` example in §6.1) is the same table used for a
displayable alternate name rather than a retired id; the two differ only in that column.

### 6.5 Correct generated data

Corrections and per-machine assignments live in exactly two files, never inside `extract/` itself
(data-model.md §5):

| File                                | Tables                                                                                                          | Mandatory `reason`?                                          |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `data/correction/machine.json`      | `machine_correction` (scalar fixes to name/year/manufacturer), `machine_system` (per-machine system assignment) | `machine_correction`: yes. `machine_system`: no — see below. |
| `data/correction/machine_chip.json` | `machine_chip_correction` (add/remove/set a BOM row)                                                            | Yes                                                          |

`data/correction/machine.json` (illustrative shape — see the caveat after the next example):

<!-- prettier-ignore -->
```json
{
  "machine_correction": [
    {
      "machine_id": "outrun",
      "year": 1986,
      "reason": "MAME lists 19?? for this set; the JAMMA PCB silkscreen and Sega's own catalog date it 1986.",
      "source_url": "https://example.org/outrun-pcb-photo"
    }
  ],
  "machine_system": [
    {
      "machine_id": "outrun",
      "system_id": "sega-outrun-hw"
    }
  ]
}
```

`data/correction/machine_chip.json` (illustrative shape):

<!-- prettier-ignore -->
```json
{
  "machine_chip_correction": [
    {
      "machine_id": "outrun",
      "mame_tag": "ymsnd",
      "chip_id": "ym2151",
      "op": "set",
      "clock_hz": 4000000,
      "reason": "MAME's driver clocks this tag from a divider that resolves to 4 MHz on this PCB revision, not the 3.58 MHz default."
    }
  ]
}
```

`op` is `add`, `remove`, or `set` — there is no fourth value; inventing one is a schema change, not a data
change. `remove` carries no `clock_hz`/`quantity`; `set` must change at least one.

`machine_correction.reason` and `machine_chip_correction.reason` are `NOT NULL` — a correction without a
stated reason isn't reviewable. `machine_system.reason` is optional and _by design_: a row's presence here is
an **assignment**, not an apology — one driver file legitimately hosting more than one system is a structural
fact, not a mistake anyone made (data-model.md §1.5). A curator overriding a plausible `system_driver` default
should still explain why, but isn't required to.

**Why not just edit `extract/` directly?** Because it would be silently discarded. `extract/` is the
deterministic output of the MAME parser and is regenerated wholesale on every MAME release (Standing rule 1);
a hand-edit sitting in a generated file gets clobbered the moment the pipeline runs again, and the mistake it
was fixing quietly comes back. A correction row, by contrast, is applied by a load-time pass
(`machine_chip_correction`) or by view (`machine_correction`, `machine_system`) every time the database is
built, so it survives every re-extraction.

**Current limitation, stated plainly:** as of this writing, `extract/` contains only the MAME parser's raw
intermediate output (`extract/*.raw.json`, deliberately excluded from row-file discovery — see
`RAW_EXTRACT_SUFFIX` in `pipeline/src/db/rowfiles.ts`), not the normalized `extract/machine.json` /
`extract/machine_chip.json` tables a correction actually targets. There is therefore no real `machine_id` in
this checkout yet for `PRAGMA foreign_key_check` to validate a correction row against. The two examples above
are illustrative of the row shape — they are schema-valid but not yet FK-checkable against real MAME data. That
changes the moment the normalized machine tables land; the mechanism itself is already fully specified and
already enforced by `schemas/schema.sql` and its row schemas.

## 7. PR expectations

- `npm run validate` shows zero errors. If it shows warnings, either resolve them or say why not in the PR
  description (e.g. "license intentionally left unverified — filed as a follow-up").
- `npm run format` and `npm run lint` are clean (Prettier covers this repo's JSON, Markdown, and YAML; ESLint
  covers TypeScript).
- Every non-obvious fact has a citation — a `notes` field, a `chip_datasheet` URL, a correction's `source_url`,
  or a link in the commit message (Standing rule 3, §4 above).
- No hand-edits under `extract/` or `dist/` (Standing rule 1).
- No renamed slugs (Standing rule 5) — see §6.4 if you need one.
- A `chip_function` addition also updates `docs/taxonomy.md` in the same PR (§5).

See [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md) for the checklist the template
itself walks you through, and the issue forms under
[`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/) if you'd rather propose a mapping, an implementation, or a
correction before writing the JSON yourself.
