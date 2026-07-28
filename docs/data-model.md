# BOM Squad Data Model

**Spec version 2.0.0 · Normative · Replaces spec 1.0.0 in full**

This document specifies BOM Squad's relational schema: tables, keys, foreign keys, storage layout, correction
mechanism, and the queries the project exists to answer. It supersedes spec 1.0.0 (git `d747680`) entirely.
Where any other document disagrees with this one on structure, this one wins.

RFC 2119 keywords (MUST, MUST NOT, SHOULD, MAY) apply.

Delegated: the `chip_function` value set and its prospector bands are owned by [taxonomy.md](taxonomy.md);
the domain reasoning behind individual `chip_equivalence` rows by [coverage.md](coverage.md) §1–§2
(its file-shape and class-algebra sections, §2/§4.2/§5.1, are void — see §2.5). Neither may alter a table,
column, key, or constraint defined here.

---

## 0. Shape of the design

Three statements govern everything below.

1. **SQLite is the query engine.** `dist/bomsquad.sqlite` is the primary published artifact and the thing the
   SPA loads. Curated JSON in `data/` is the source of truth in Git; the database is a build output. There is
   no chunked-JSON delivery format — the dataset is one small file.
2. **The schema does the validating.** `FOREIGN KEY`, `CHECK`, `UNIQUE`, `NOT NULL` and `STRICT` typing are
   the integrity layer. Hand-written validators exist only for the handful of rules SQL cannot express (§5.4).
3. **Derived numbers are views.** Coverage, counts, rankings, reverse indexes and the device worklist are
   `CREATE VIEW`. No base table stores a value computable from other rows.

### 0.1 Table conventions

| Convention            | Rule                                                                                                                              |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `STRICT`              | every table. Column types are enforced; `"19??"` cannot land in an `INTEGER` year.                                                |
| `WITHOUT ROWID`       | every table. All primary keys are natural and textual; rows are narrow. Also makes PK columns implicitly `NOT NULL`.              |
| Booleans              | `INTEGER NOT NULL CHECK (x IN (0,1))`. SQLite has no boolean type under `STRICT`.                                                 |
| Dates                 | `TEXT` in `YYYY-MM-DD`, `CHECK … GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`.                                              |
| Nullability           | a column is `NULL`-able exactly when "unknown" is a legitimate state. Standing rule 3: omit, never guess.                         |
| `PRAGMA foreign_keys` | OFF during load (so rows may be inserted in any table order), then `PRAGMA foreign_key_check` once. ON in every consumer session. |

### 0.2 When a value set becomes a table

The maintainer asked for lookup tables instead of repeated free text. The line this spec draws:

> **A value set gets its own table when adding a member is a pure data change. It gets a `CHECK` constraint
> when adding a member would require changing code or a view.**

So `implementation_kind`, `chip_function`, `chip_role`, `fpga_platform`, `hdl_language`, `accuracy_level`,
`system_kind`, `manufacturer`, `license` and `chip_family` are tables — a new manufacturer or a new FPGA
platform is data. `chip_equivalence.kind` and `machine_chip_correction.op` are `CHECK`s — the satisfaction
view hard-codes what `equivalent` and `provides` mean, and the loader hard-codes what `add`/`remove`/`set` do,
so a third value would be a lie until someone wrote code for it.

### 0.3 `ON DELETE` policy

| Relationship                                 | Behaviour  | Why                                                                     |
| -------------------------------------------- | ---------- | ----------------------------------------------------------------------- |
| child row meaningless without its parent     | `CASCADE`  | deleting a chip deletes its aliases and datasheets                      |
| reference to a dimension/lookup row          | `RESTRICT` | deleting a function or license that is in use must fail loudly          |
| reference to a fact another table depends on | `RESTRICT` | deleting a chip a BOM uses must fail, not silently gut the BOM          |
| a deliberate curator decision                | `RESTRICT` | deleting a system must not silently discard the machines assigned to it |

There is no `SET NULL` foreign key. The one column that had it — `machine.parent_machine_id` —
is deleted (§1.3), and quietly blanking a curated pointer is a worse failure than refusing the delete.

Note the deliberate asymmetry on `system_chip`: `system_id` is `CASCADE` (delete a system, delete its BOM),
`chip_id` is `RESTRICT` (a chip in use cannot be deleted). Same on `machine_chip`.

---

## 1. The tables

36 tables, 21 views, 34 explicit indexes — the counts `schemas/schema.sql` creates, read back from
`sqlite_master` by `pipeline/test/schema.test.ts`, which fails if this sentence and the DDL disagree.
Every table has a primary key; every relationship is a declared foreign key. Appendix A is the normative
DDL; the tables below give each column's meaning. §2's audit enumerates all 36 by name.

### 1.1 Lookup tables

#### `manufacturer` — an organization that made silicon or hardware.

| Column            | Type | Null | Key | Meaning                       |
| ----------------- | ---- | ---- | --- | ----------------------------- |
| `manufacturer_id` | TEXT | no   | PK  | slug, e.g. `yamaha`           |
| `name`            | TEXT | no   |     | display name, e.g. `Yamaha`   |
| `country`         | TEXT | yes  |     | ISO 3166-1 alpha-2, e.g. `JP` |
| `notes`           | TEXT | yes  |     | free text                     |

#### `manufacturer_alias` — every string that resolves to a manufacturer.

Carries MAME's free-text `manufacturer` attribute into the normalized vocabulary, and doubles as a search alias.

| Column            | Type | Null | Key                                       | Meaning                                        |
| ----------------- | ---- | ---- | ----------------------------------------- | ---------------------------------------------- |
| `alias`           | TEXT | no   | PK                                        | verbatim string, e.g. `Sega Enterprises, Ltd.` |
| `manufacturer_id` | TEXT | no   | FK → `manufacturer` **ON DELETE CASCADE** | resolves to                                    |

#### `license` — an SPDX-identified license.

| Column            | Type    | Null | Key | Meaning                                   |
| ----------------- | ------- | ---- | --- | ----------------------------------------- |
| `license_id`      | TEXT    | no   | PK  | SPDX id, e.g. `GPL-3.0-only`, or `custom` |
| `name`            | TEXT    | no   |     | display name                              |
| `url`             | TEXT    | yes  |     | canonical license text                    |
| `is_osi_approved` | INTEGER | no   |     | 0/1                                       |

#### `chip_function` — the taxonomy value set ([taxonomy.md](taxonomy.md) §8, 26 values).

| Column            | Type | Null | Key | Meaning                                       |
| ----------------- | ---- | ---- | --- | --------------------------------------------- |
| `function_id`     | TEXT | no   | PK  | slug, e.g. `sound-fm`, `video-tilemap`        |
| `label`           | TEXT | no   |     | display name                                  |
| `description`     | TEXT | no   |     | one-line definition                           |
| `prospector_band` | TEXT | no   |     | `hard` \| `medium` \| `soft` (taxonomy.md §5) |

`prospector_band` is a domain classification of the function, not a score. The numeric weight per band stays in
`pipeline/config/`, so retuning the Prospector never touches data.

#### `chip_family` — a manufacturer's part family, used as a grouping facet.

| Column            | Type | Null | Key                                        | Meaning                  |
| ----------------- | ---- | ---- | ------------------------------------------ | ------------------------ |
| `family_id`       | TEXT | no   | PK                                         | slug, e.g. `opm`, `m68k` |
| `name`            | TEXT | no   |                                            | e.g. `OPM`               |
| `manufacturer_id` | TEXT | yes  | FK → `manufacturer` **ON DELETE RESTRICT** | owner of the family      |
| `description`     | TEXT | yes  |                                            |                          |

#### `chip_role` — the controlled vocabulary for a chip's position on a curated board.

Seed values: `maincpu`, `subcpu`, `audiocpu`, `mcu`, `dsp`, `sound`, `video`, `sprite`, `tilemap`, `mixer`,
`crtc`, `io`, `protection`, `memory`, `dma`, `timer`, `rtc`, `storage`, `glue`, `unspecified`.

| Column        | Type | Null | Key | Meaning      |
| ------------- | ---- | ---- | --- | ------------ |
| `role_id`     | TEXT | no   | PK  | slug         |
| `label`       | TEXT | no   |     | display name |
| `description` | TEXT | yes  |     |              |

#### `system_kind`

Seed values: `arcade`, `console`, `computer`, `handheld`, `pinball`, `other`.

| Column    | Type | Null | Key | Meaning |
| --------- | ---- | ---- | --- | ------- |
| `kind_id` | TEXT | no   | PK  | slug    |
| `label`   | TEXT | no   |     |         |

#### `hdl_language`

Seed values: `verilog`, `systemverilog`, `vhdl`, `chisel`, `mixed`, `other`, plus `c`, `cpp` for
`software_emulation` implementations.

| Column        | Type | Null | Key | Meaning |
| ------------- | ---- | ---- | --- | ------- |
| `language_id` | TEXT | no   | PK  | slug    |
| `label`       | TEXT | no   |     |         |

#### `fpga_platform`

Seed values: `mister`, `pocket`, `mist`, `replay`, `neptuno`, `generic`, `other`.

| Column        | Type | Null | Key | Meaning                    |
| ------------- | ---- | ---- | --- | -------------------------- |
| `platform_id` | TEXT | no   | PK  | slug                       |
| `label`       | TEXT | no   |     |                            |
| `notes`       | TEXT | yes  |     | device family, board notes |

#### `implementation_kind` — how a thing is realized. **The generic discriminator.**

Seed values: `fpga_hdl`, `software_emulation`, `original_silicon`. New kinds (netlist simulation, a
transistor-level model, an ASIC respin) are inserts, not schema changes.

| Column        | Type | Null | Key | Meaning |
| ------------- | ---- | ---- | --- | ------- |
| `kind_id`     | TEXT | no   | PK  | slug    |
| `label`       | TEXT | no   |     |         |
| `description` | TEXT | no   |     |         |

#### `accuracy_level`

Seed values: `gate-level`, `cycle-accurate`, `cycle-approximate`, `behavioral`, `partial`.

| Column        | Type | Null | Key | Meaning |
| ------------- | ---- | ---- | --- | ------- |
| `accuracy_id` | TEXT | no   | PK  | slug    |
| `label`       | TEXT | no   |     |         |
| `description` | TEXT | no   |     |         |

### 1.2 Chips

#### `chip` — one row per canonical part.

| Column             | Type    | Null | Key                                         | Meaning                                       |
| ------------------ | ------- | ---- | ------------------------------------------- | --------------------------------------------- |
| `chip_id`          | TEXT    | no   | PK                                          | slug, e.g. `ym2151`                           |
| `display_name`     | TEXT    | no   |                                             | primary name, e.g. `YM2151`                   |
| `function_id`      | TEXT    | no   | FK → `chip_function` **ON DELETE RESTRICT** | taxonomy classification                       |
| `manufacturer_id`  | TEXT    | yes  | FK → `manufacturer` **ON DELETE RESTRICT**  |                                               |
| `family_id`        | TEXT    | yes  | FK → `chip_family` **ON DELETE RESTRICT**   |                                               |
| `model`            | TEXT    | yes  |                                             | manufacturer part number                      |
| `description`      | TEXT    | yes  |                                             | one sentence                                  |
| `typical_clock_hz` | INTEGER | yes  |                                             | `> 0`                                         |
| `package`          | TEXT    | yes  |                                             | e.g. `DIP-24`                                 |
| `year_introduced`  | INTEGER | yes  |                                             | 1950–2100                                     |
| `notes`            | TEXT    | yes  |                                             | free text; cite sources for non-obvious facts |

#### `chip_datasheet` — 1:N documentation links. Fixes `chip.datasheet_urls[]`.

| Column    | Type | Null | Key                                    | Meaning        |
| --------- | ---- | ---- | -------------------------------------- | -------------- |
| `chip_id` | TEXT | no   | PK₁, FK → `chip` **ON DELETE CASCADE** |                |
| `url`     | TEXT | no   | PK₂                                    | absolute URI   |
| `title`   | TEXT | yes  |                                        | document title |

#### `chip_name` — 1:N alternate names **and** the chip alias mechanism. Fixes `chip.names[]`.

| Column    | Type | Null | Key                                    | Meaning                                             |
| --------- | ---- | ---- | -------------------------------------- | --------------------------------------------------- |
| `chip_id` | TEXT | no   | PK₁, FK → `chip` **ON DELETE CASCADE** | the chip this string resolves to                    |
| `name`    | TEXT | no   | PK₂, `UNIQUE` globally                 | alternate name or retired id                        |
| `kind`    | TEXT | no   | `CHECK IN ('alias','retired_id')`      | `alias` = displayable; `retired_id` = redirect only |

`UNIQUE(name)` makes name → chip a function, which is what a resolver needs. `display_name` lives on `chip`
because a chip has exactly one of them; `chip_name` holds only the alternates.

#### `mame_device` — the MAME device dictionary. Replaces `mappings/mame-device-map.json` in full.

Named after its key, not after `chip`, because it also holds ignore rows that reference no chip.

| Column          | Type | Null | Key                                | Meaning                                                    |
| --------------- | ---- | ---- | ---------------------------------- | ---------------------------------------------------------- |
| `mame_device`   | TEXT | no   | PK                                 | MAME device lookup key                                     |
| `chip_id`       | TEXT | yes  | FK → `chip` **ON DELETE RESTRICT** | the part this device is                                    |
| `ignore_reason` | TEXT | yes  |                                    | why this device is not board silicon (`screen`, `speaker`) |
| `note`          | TEXT | yes  |                                    | justification for a non-obvious mapping                    |

`CHECK ((chip_id IS NULL) <> (ignore_reason IS NULL))` — a device is mapped **or** explicitly ignored, never
both, never neither. A device with no row at all is _unmapped_ and flows to `machine_unmapped_device` (§1.3).
The PK on `mame_device` alone encodes the functional dependency `mame_device → chip_id`: one device cannot map
to two chips, structurally.

#### `chip_equivalence` — chip→chip substitution edges. Fixes `equivalences.classes[].chips[]`.

| Column         | Type | Null | Key                                    | Meaning                                                    |
| -------------- | ---- | ---- | -------------------------------------- | ---------------------------------------------------------- |
| `from_chip_id` | TEXT | no   | PK₁, FK → `chip` **ON DELETE CASCADE** | the provider                                               |
| `to_chip_id`   | TEXT | no   | PK₂, FK → `chip` **ON DELETE CASCADE** | the socket                                                 |
| `kind`         | TEXT | no   | `CHECK IN ('equivalent','provides')`   | symmetric interchange, or one-way substitution             |
| `note`         | TEXT | no   |                                        | mandatory justification with a citation (coverage.md §5.6) |

`CHECK (from_chip_id <> to_chip_id)` kills self-edges. `CHECK (kind <> 'equivalent' OR from_chip_id < to_chip_id)`
stores each symmetric pair exactly once — the view `v_chip_satisfies` reads it in both directions, so the
database never holds the mirror row. Neither relation is transitively closed; a curator states each pair
(coverage.md §2.1's soundness argument, now applied to `equivalent` as well).

### 1.3 Hardware

#### `system` — an arcade system, board family, or console. **Curated. First-class.**

| Column            | Type    | Null | Key                                        | Meaning                     |
| ----------------- | ------- | ---- | ------------------------------------------ | --------------------------- |
| `system_id`       | TEXT    | no   | PK                                         | slug, e.g. `sega-system16a` |
| `name`            | TEXT    | no   |                                            | `Sega System 16A`           |
| `kind_id`         | TEXT    | no   | FK → `system_kind` **ON DELETE RESTRICT**  |                             |
| `manufacturer_id` | TEXT    | yes  | FK → `manufacturer` **ON DELETE RESTRICT** |                             |
| `year_introduced` | INTEGER | yes  |                                            | 1950–2100                   |
| `description`     | TEXT    | yes  |                                            |                             |
| `notes`           | TEXT    | yes  |                                            |                             |

#### `system_name` — alternate names and retired ids for a system. Same contract as `chip_name`.

| Column      | Type | Null | Key                                      | Meaning                   |
| ----------- | ---- | ---- | ---------------------------------------- | ------------------------- |
| `system_id` | TEXT | no   | PK₁, FK → `system` **ON DELETE CASCADE** |                           |
| `name`      | TEXT | no   | PK₂, `UNIQUE` globally                   | e.g. `Capcom Play System` |
| `kind`      | TEXT | no   | `CHECK IN ('alias','retired_id')`        |                           |

#### `system_chip` — **THE BOM.** The curated bill of materials of a board.

| Column      | Type    | Null | Key                                          | Meaning                                    |
| ----------- | ------- | ---- | -------------------------------------------- | ------------------------------------------ |
| `system_id` | TEXT    | no   | PK₁, FK → `system` **ON DELETE CASCADE**     |                                            |
| `role_id`   | TEXT    | no   | PK₂, FK → `chip_role` **ON DELETE RESTRICT** | position on the board                      |
| `chip_id`   | TEXT    | no   | PK₃, FK → `chip` **ON DELETE RESTRICT**      | the part                                   |
| `quantity`  | INTEGER | no   | default 1, `CHECK >= 1`                      | identical parts in this role               |
| `clock_hz`  | INTEGER | yes  | `CHECK > 0`                                  | as fitted on this board                    |
| `note`      | TEXT    | yes  |                                              | e.g. "on the optional sound daughterboard" |

The three-column key is forced by the domain: one chip in two roles (Z80 as `maincpu` and as `audiocpu`), and
two chips in one role (two different sound parts, both `sound`), are both real. `quantity` collapses only
genuinely identical instances.

Adding `data/system/sega-system16a.json` with its `system_chip` rows is the _entire_ effort of surfacing
what HDL already exists for System 16A. No other table needs touching.

#### `system_driver` — the **bulk default** mapping a MAME driver source file to a system.

| Column            | Type | Null | Key                                 | Meaning                                |
| ----------------- | ---- | ---- | ----------------------------------- | -------------------------------------- |
| `mame_sourcefile` | TEXT | no   | PK                                  | e.g. `sega/segas16a.cpp`               |
| `system_id`       | TEXT | no   | FK → `system` **ON DELETE CASCADE** | default system for every machine in it |

The PK is `mame_sourcefile` **alone**, not `(system_id, mame_sourcefile)`, and the rule it states is
_"unless something says otherwise, every machine in this driver belongs to this system."_ That is a default,
not a functional dependency: one MAME driver `.cpp` routinely hosts several distinct systems
(`nintendo/vsnes.cpp` is VS. UniSystem **and** VS. DualSystem; `sega/segas16b.cpp` also carries System 16C
and the ISG Selection Master). The per-machine truth lives in `machine_system` and overrides this row;
see §1.5 and the precedence sentence under `v_machine_system` in §1.6.

Keying on the source file alone still makes "two systems claim one driver **as their default**" a `UNIQUE`
violation instead of a hand-written `FAMILY_CONFLICT` gate. One deleted check — and, because the escape is a
plain assignment rather than a correction with a mandatory `reason`, a multi-system driver costs one row per
machine and no prose.

#### `machine` — one MAME machine. **Generated. 100% MAME vocabulary, zero curated columns.**

**Parents-only.** Extraction records parent machines and drops clone rows (TASKS T2.3, "parents-only by
default (record clone count on the parent)"), so this table contains no clone and therefore needs no parent
pointer. `machine.parent_machine_id` and its self-FK are deleted: a nullable self-FK that can never be
satisfied makes every query conditional for nothing.

| Column              | Type    | Null | Key                                           | Meaning                                          |
| ------------------- | ------- | ---- | --------------------------------------------- | ------------------------------------------------ |
| `machine_id`        | TEXT    | no   | PK                                            | MAME shortname verbatim, e.g. `outrun`           |
| `name`              | TEXT    | no   |                                               | MAME `description`                               |
| `mame_sourcefile`   | TEXT    | no   |                                               | driver source path                               |
| `mame_year`         | TEXT    | yes  |                                               | **verbatim**, may be `19??`                      |
| `mame_manufacturer` | TEXT    | yes  |                                               | **verbatim**; resolved via `manufacturer_alias`  |
| `clone_count`       | INTEGER | yes  | `CHECK >= 1`                                  | how many clone sets MAME lists under this parent |
| `driver_status`     | TEXT    | yes  | `CHECK IN ('good','imperfect','preliminary')` |                                                  |
| `is_bios`           | INTEGER | no   | 0/1                                           |                                                  |
| `is_device`         | INTEGER | no   | 0/1                                           |                                                  |
| `is_mechanical`     | INTEGER | no   | 0/1                                           |                                                  |

**`clone_count` is a base fact, not a derived one.** It is what MAME says about the parent — how many sets
the parents-only filter folded away — and there is nothing in this database it could be computed from,
because the clone rows are not here. It is therefore neither a stored aggregate nor a 3NF violation, and
`v_machine` republishes it unchanged. Ingesting clone rows later would mean adding `parent_machine_id` back:
**a schema change, not a data change**, and the point at which `clone_count` would become derivable and have
to go.

There is no `system_id` column and no `kind` column. Both are curated facts resolved by views
(`v_machine_system`, and kind via `system.kind_id`), which is what keeps `extract/` free of curation and
standing rule 1 structurally true rather than merely asserted.

`mame_year` and `mame_manufacturer` stay `TEXT` on purpose: they record **what MAME says**, which is itself
the datum. The project's normalized facts are `v_machine.year` (parsed only when the string is four digits)
and `v_machine.manufacturer_id` (joined through `manufacturer_alias`). That is not denormalization — the two
columns are different attributes of different subjects.

#### `machine_chip` — MAME's per-title BOM. Fixes `machine.chips[]`.

| Column       | Type    | Null | Key                                       | Meaning                                      |
| ------------ | ------- | ---- | ----------------------------------------- | -------------------------------------------- |
| `machine_id` | TEXT    | no   | PK₁, FK → `machine` **ON DELETE CASCADE** |                                              |
| `mame_tag`   | TEXT    | no   | PK₂                                       | MAME `<chip tag>`, or the reserved `:device` |
| `chip_id`    | TEXT    | no   | PK₃, FK → `chip` **ON DELETE RESTRICT**   |                                              |
| `clock_hz`   | INTEGER | yes  | `CHECK > 0`                               |                                              |
| `quantity`   | INTEGER | no   | default 1, `CHECK >= 1`                   |                                              |

Rows derived from `<device_ref>` (which carries no tag) use `mame_tag = ':device'`. Leading colons are
stripped from real MAME tags during extraction, so the sentinel is structurally uncollidable.

**The real key of a tagged row is `(machine_id, mame_tag)`, and a partial unique index says so:**

```sql
CREATE UNIQUE INDEX ux_machine_chip_tag
  ON machine_chip(machine_id, mame_tag) WHERE mame_tag <> ':device';
```

A MAME tag names one socket in one machine, and one socket holds one part, so
`(machine_id, mame_tag) → chip_id, clock_hz, quantity`. `chip_id` is in the primary key only so that the
tagless `:device` rows — which have no socket to be keyed by — can coexist; without the index above,
`('outrun','maincpu','m68000')` and `('outrun','maincpu','z80')` both insert, which is two chips in one
socket and inflates `chips_total` for the whole system. The same index exists on `machine_chip_correction`,
so a correction cannot create the anomaly either.

#### `machine_unmapped_device` — devices seen in MAME with no `mame_device` row. **Replaces the `unknown:*` convention.**

| Column        | Type    | Null | Key                                       | Meaning                   |
| ------------- | ------- | ---- | ----------------------------------------- | ------------------------- |
| `machine_id`  | TEXT    | no   | PK₁, FK → `machine` **ON DELETE CASCADE** |                           |
| `mame_device` | TEXT    | no   | PK₂                                       | the unmapped lookup key   |
| `quantity`    | INTEGER | no   | default 1, `CHECK >= 1`                   | instances in this machine |

Nothing is silently dropped: every MAME device reference is mapped, explicitly ignored, or lands here. This
table deletes an entire v1 subsystem — the `unknown:` id namespace, its reserved-prefix grammar, stub-chip
materialization in `dist`, the `UNKNOWN_IN_CURATED` grep gate, and `extract/mame-devices.raw.json` (the
curation worklist is now the view `v_mame_device_worklist`).

### 1.4 Implementations

The maintainer's key insight, implemented: **one generic `implementation` table** discriminated by
`kind_id`, targeting chips and/or systems through two typed junctions.

#### `project` — a source of implementations.

| Column       | Type | Null | Key | Meaning                                     |
| ------------ | ---- | ---- | --- | ------------------------------------------- |
| `project_id` | TEXT | no   | PK  | slug, e.g. `jotego`, `mame`, `mister-devel` |
| `name`       | TEXT | no   |     |                                             |
| `url`        | TEXT | yes  |     | repository or homepage                      |
| `author`     | TEXT | yes  |     | principal author or team                    |
| `notes`      | TEXT | yes  |     |                                             |

`project_id` is nullable on `implementation`: for `original_silicon` the producer is already recorded as the
chip's or system's `manufacturer_id`, and minting a synthetic project row would store that fact twice.

#### `implementation` — a realization of one or more chips and/or systems.

| Column                      | Type    | Null | Key                                               | Meaning                                 |
| --------------------------- | ------- | ---- | ------------------------------------------------- | --------------------------------------- |
| `implementation_id`         | TEXT    | no   | PK                                                | slug, e.g. `jt51`, `mister-arcade-cps1` |
| `name`                      | TEXT    | no   |                                                   | display name                            |
| `kind_id`                   | TEXT    | no   | FK → `implementation_kind` **ON DELETE RESTRICT** | `fpga_hdl` \| `software_emulation` \| … |
| `project_id`                | TEXT    | yes  | FK → `project` **ON DELETE RESTRICT**             |                                         |
| `repo_url`                  | TEXT    | yes  |                                                   | when it differs from the project's      |
| `hdl_language_id`           | TEXT    | yes  | FK → `hdl_language` **ON DELETE RESTRICT**        |                                         |
| `license_id`                | TEXT    | yes  | FK → `license` **ON DELETE RESTRICT**             | verified from the repo, never guessed   |
| `accuracy_id`               | TEXT    | yes  | FK → `accuracy_level` **ON DELETE RESTRICT**      |                                         |
| `verified_against_hardware` | INTEGER | yes  | 0/1                                               | `1` requires a citation in `notes`      |
| `resource_notes`            | TEXT    | yes  |                                                   | e.g. `≈3k LEs on Cyclone V`             |
| `last_reviewed`             | TEXT    | yes  | `YYYY-MM-DD`                                      |                                         |
| `notes`                     | TEXT    | yes  |                                                   |                                         |

`CHECK (kind_id <> 'original_silicon' OR (repo_url IS NULL AND hdl_language_id IS NULL AND license_id IS
NULL AND accuracy_id IS NULL))`. Original silicon is the part as manufactured, not a codebase: it has no
repository, no HDL language, no SPDX licence, and no accuracy to assess because it _is_ the reference. This
names the one seeded kind whose attribute set is empty; it privileges nothing, and a new `implementation_kind`
row is unconstrained by it. Without the rule, an `original_silicon` row could carry `repo_url` and
`hdl_language_id`, and `IMPL_UNVERIFIED_LICENSE` / `IMPL_UNVERIFIED_ACCURACY` would accuse it forever of
lacking two attributes it is forbidden to have. Those two warnings carry the matching kind filter
(data-quality.md §4).

There is no `core` table. A MiSTer core is an `implementation` with `kind_id = 'fpga_hdl'` and a row in
`implementation_system`. MAME's `cps1.cpp` driver is one with `kind_id = 'software_emulation'`. The physical
CPS-1 PCB is one with `kind_id = 'original_silicon'`. All three answer "how has CPS-1 been realized?" from the
same three tables.

#### `implementation_chip` — N:M. Fixes `implementation.chip_ids[]`.

| Column              | Type | Null | Key                                              |
| ------------------- | ---- | ---- | ------------------------------------------------ |
| `implementation_id` | TEXT | no   | PK₁, FK → `implementation` **ON DELETE CASCADE** |
| `chip_id`           | TEXT | no   | PK₂, FK → `chip` **ON DELETE RESTRICT**          |

N:M, not a column, because one IP genuinely covers several parts (a configurable 6502/65C02 core;
jt12 covering YM2612 and YM3438) — coverage.md §1.7 rung 6.

#### `implementation_system` — N:M. Replaces `core.platform_families[]`.

| Column              | Type | Null | Key                                              |
| ------------------- | ---- | ---- | ------------------------------------------------ |
| `implementation_id` | TEXT | no   | PK₁, FK → `implementation` **ON DELETE CASCADE** |
| `system_id`         | TEXT | no   | PK₂, FK → `system` **ON DELETE RESTRICT**        |

#### `implementation_path` — 1:N source paths. Fixes `implementation.paths[]`.

| Column              | Type    | Null | Key                                              | Meaning              |
| ------------------- | ------- | ---- | ------------------------------------------------ | -------------------- |
| `implementation_id` | TEXT    | no   | PK₁, FK → `implementation` **ON DELETE CASCADE** |                      |
| `path`              | TEXT    | no   | PK₂                                              | repo-relative        |
| `is_top`            | INTEGER | no   | default 0, 0/1                                   | the top-level module |

v1 encoded "first entry is the top-level module" as array order — order-significant arrays are the 1NF smell.
`is_top` states the fact, and a partial unique index (`… ON implementation_path(implementation_id) WHERE is_top = 1`)
enforces at most one per implementation.

#### `implementation_platform` — N:M. Fixes `implementation.target_platforms[]`.

| Column              | Type | Null | Key                                              |
| ------------------- | ---- | ---- | ------------------------------------------------ |
| `implementation_id` | TEXT | no   | PK₁, FK → `implementation` **ON DELETE CASCADE** |
| `platform_id`       | TEXT | no   | PK₂, FK → `fpga_platform` **ON DELETE RESTRICT** |

#### `implementation_machine` — N:M. Which machines an implementation actually runs. Replaces `core.machines[]`.

| Column              | Type | Null | Key                                              |
| ------------------- | ---- | ---- | ------------------------------------------------ |
| `implementation_id` | TEXT | no   | PK₁, FK → `implementation` **ON DELETE CASCADE** |
| `machine_id`        | TEXT | no   | PK₂, FK → `machine` **ON DELETE RESTRICT**       |

#### `implementation_dependency` — N:M, self-referencing. Replaces `implementation.known_consumers[]`.

| Column        | Type | Null | Key                                               | Meaning                          |
| ------------- | ---- | ---- | ------------------------------------------------- | -------------------------------- |
| `consumer_id` | TEXT | no   | PK₁, FK → `implementation` **ON DELETE CASCADE**  | the core                         |
| `provider_id` | TEXT | no   | PK₂, FK → `implementation` **ON DELETE RESTRICT** | the IP it consumes               |
| `note`        | TEXT | yes  |                                                   | e.g. "OPM sound", submodule path |

`CHECK (consumer_id <> provider_id)`. This is the table that makes "core → its HDL files" a traversal:
`implementation_dependency` → `implementation_path`. `known_consumers` is the same table read backwards
(`WHERE provider_id = 'jt51'`) and therefore is not stored, not derived, and not overlay-patched.
Because both endpoints are implementations, a core may also consume another core.

### 1.5 Assignments, corrections and build metadata

Two correction tables replace v1's overlay merge algebra (semantics in §5), one assignment table carries a
structural fact the driver defaults cannot, and two tables carry build-level facts.

#### `machine_correction` — scalar fixes to a MAME machine. `NULL` = no override.

| Column            | Type    | Null | Key                                        | Meaning                |
| ----------------- | ------- | ---- | ------------------------------------------ | ---------------------- |
| `machine_id`      | TEXT    | no   | PK, FK → `machine` **ON DELETE CASCADE**   |                        |
| `name`            | TEXT    | yes  |                                            | corrected display name |
| `year`            | INTEGER | yes  | 1950–2100                                  | corrected year         |
| `manufacturer_id` | TEXT    | yes  | FK → `manufacturer` **ON DELETE RESTRICT** | corrected manufacturer |
| `reason`          | TEXT    | no   |                                            | mandatory provenance   |
| `source_url`      | TEXT    | yes  |                                            | citation               |

#### `machine_system` — per-machine system assignment. Row present = authoritative.

| Column       | Type | Null | Key                                      | Meaning                         |
| ------------ | ---- | ---- | ---------------------------------------- | ------------------------------- |
| `machine_id` | TEXT | no   | PK, FK → `machine` **ON DELETE CASCADE** |                                 |
| `system_id`  | TEXT | yes  | FK → `system` **ON DELETE RESTRICT**     | `NULL` = deliberately no system |
| `reason`     | TEXT | yes  |                                          | optional provenance             |

**This is an assignment, not a correction, and that is why `reason` is optional.** A driver `.cpp` hosting
two systems is structural, not a mistake anyone made (§1.3, `system_driver`); demanding a written apology per
machine would mean hundreds of hand-authored sentences restating the same fact. A curator who _is_ overruling
a plausible default should still say why, and the column is there for it.

`ON DELETE RESTRICT`, not `CASCADE`: cascading would delete the curator's deliberate decision when the system
it points at is removed, silently resurrecting the very `system_driver` default that was overridden. Refusing
the delete is the only honest option.

Separate from `machine_correction` precisely so `NULL` can mean "deliberately no system" here while meaning
"no correction" there. Two tables, two unambiguous meanings, zero sentinel columns.

#### `machine_chip_correction` — BOM row fixes.

| Column       | Type    | Null | Key                                       | Meaning               |
| ------------ | ------- | ---- | ----------------------------------------- | --------------------- |
| `machine_id` | TEXT    | no   | PK₁, FK → `machine` **ON DELETE CASCADE** |                       |
| `mame_tag`   | TEXT    | no   | PK₂                                       | target row's tag      |
| `chip_id`    | TEXT    | no   | PK₃, FK → `chip` **ON DELETE RESTRICT**   | target row's chip     |
| `op`         | TEXT    | no   | `CHECK IN ('add','remove','set')`         |                       |
| `clock_hz`   | INTEGER | yes  | `CHECK > 0`                               | value for `add`/`set` |
| `quantity`   | INTEGER | yes  | `CHECK >= 1`                              | value for `add`/`set` |
| `reason`     | TEXT    | no   |                                           | mandatory provenance  |
| `source_url` | TEXT    | yes  |                                           | citation              |

#### `dataset_meta` — free-form build facts.

| Column  | Type | Null | Key | Meaning                                                                                |
| ------- | ---- | ---- | --- | -------------------------------------------------------------------------------------- |
| `key`   | TEXT | no   | PK  | `mame_version`, `dataset_version`, `schema_version`, `build_date`, `threshold_version` |
| `value` | TEXT | no   |     |                                                                                        |

v1 stamped `mame_version` on every machine record. That is redundancy with an update anomaly on every MAME
bump; it belongs to the build, not to a machine.

Genuinely free-form only. Numeric policy is **not** stored here — see `threshold` below.

#### `threshold` — typed quality policy, read by the quality views.

| Column  | Type | Null | Key | Meaning                                                       |
| ------- | ---- | ---- | --- | ------------------------------------------------------------- |
| `name`  | TEXT | no   | PK  | dotted config path, e.g. `issue_generator.min_instance_count` |
| `value` | REAL | no   |     | `CHECK (value >= 0)`                                          |

Views take no parameters, so the quality gates of [data-quality.md](data-quality.md) §4 must read their
policy from a table. They used to read it from `dataset_meta` through a `v_threshold` view that `CAST` text
to a number, and it **failed open in two different ways**: a value that stopped parsing `CAST`ed to `0.0`
and quietly stopped its comparison from ever being true again, and a deleted row made the comparison `NULL`,
which is also never true. A gate that switches itself off when its configuration rots is worse than no gate.

A typed column fixes the first — a malformed value cannot be stored at all — and the loader fixes the
second: it writes every numeric leaf of `pipeline/config/quality-thresholds.json` and then asserts that
every name the shipped views read is present, failing the build otherwise. The required set is not written
down twice; it is discovered from the view SQL. `v_threshold` is deleted.

### 1.6 Views

Every column of every view is computed at query time; **no base table stores a value derivable from other
rows in this database**. (That is the claim, stated precisely. `machine.clone_count` is a base fact MAME
supplies about a parent whose clones are not in this database at all — see §1.3 — so it is not a derivation
and does not belong on this list. `mame_year` and `mame_manufacturer` are likewise source-verbatim facts,
§2.4.)

| View                          | Yields                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------- |
| `v_machine_system`            | machine → system, resolving `machine_system` over `system_driver`                   |
| `v_machine`                   | machine with corrections applied, year parsed, manufacturer resolved                |
| `v_machine_bom`               | a machine's effective BOM: its own rows, plus its system's rows for chips it lacks  |
| `v_chip_satisfies`            | (socket chip, provider chip, via) — self, `equivalent` both ways, `provides`        |
| `v_chip_implementation_count` | implementations per (chip, kind)                                                    |
| `v_system_chip_effective`     | curated `system_chip` rows, plus chips observed on the system's machines            |
| `v_system_unmapped`           | unmapped MAME devices per system — the confidence signal                            |
| `v_system_core`               | (kind, system, platform) triples that already have a system-level implementation    |
| `v_prospector`                | **Q2**: systems × platforms with no FPGA core, with coverage and confidence         |
| `v_chip_gap`                  | **Q4**: per kind, chips no implementation of that kind satisfies, with usage counts |
| `v_mame_device_worklist`      | unmapped devices ranked by impact — the curation queue                              |

**Precedence, one sentence:** a `machine_system` row wins; otherwise the `system_driver` rule for the
machine's source file applies; otherwise the machine belongs to no system.

**Coverage has exactly one definition, and it is generic.** `v_chip_fpga_direct`, `v_chip_fpga_satisfied` and
`v_system_coverage` are **deleted**. All three hardcoded `kind_id = 'fpga_hdl'` and were strict
specialisations of [coverage.md](coverage.md) §3.4's `v_chip_evidence` and `v_system_coverage_by_kind`, which
already expose `kind_id` as a column — so the project's headline metric had two SQL definitions that had to
be edited in lockstep, and the specialised one could not compute `chips_equivalent`, `chips_provided` or
`confidence`. `v_prospector` now reads the generic view and gains all three for free.

The one surviving kind filter is inside `v_prospector`, which is by definition about FPGA cores. That is
where a kind literal belongs — in the one view that is about a kind, never in a reusable one.
`v_system_fpga_core` is likewise generalised to `v_system_core`, which carries `kind_id` as a column.

The v1 plan's "coverage engine" (T6.2) is `v_system_coverage_by_kind`, and its "Prospector ranking" data
layer (T6.3) is `v_prospector`. What remains of T6.3 is weighting, which is a config file and an `ORDER BY`.

### 1.7 Decision (a): `system` and `machine` are two tables

**Decision: two tables. `system` is curated, `machine` is generated, and there is no self-referencing parent.**

| Reason                | Detail                                                                                                                                                                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provenance            | `machine` is regenerated wholesale from every MAME release. `system` is hand-authored and never regenerated. One table would mix hand-edited and machine-written rows, which standing rule 1 forbids and which no storage layout can express cleanly. |
| Independent existence | A system must be creatable with zero machines — that is the maintainer's headline requirement. Under a self-parent scheme, "Sega System 16A" would be a synthetic row inside a generated table.                                                       |
| Different attributes  | `machine` carries `mame_sourcefile`, `driver_status`, `is_bios`, `clone_count`. `system` carries `kind_id`, `year_introduced`. A merged table would be half `NULL` in every row and would need a discriminator to know which half is meaningful.      |
| Query shape           | A nullable self-FK makes every "chips of a system" query conditional on whether the row is a parent or a child. Two tables and one FK are boring SQL.                                                                                                 |

The same argument retired the last self-FK in the schema. `machine.parent_machine_id` modelled MAME's
clone hierarchy, but extraction is parents-only (§1.3), so no clone row ever exists to point at a parent:
the column was a nullable self-FK that made every query conditional and could hold nothing but `NULL`. It is
deleted. `clone_count` keeps the fact that matters.

**Where the BOM lives when a system's and a machine's differ.** In both tables, because they are facts about
different subjects and neither is derived from the other:

- `system_chip` — the curated bill of materials of the **board**. Authoritative for the board.
- `machine_chip` — what MAME's driver for **one title** models. Authoritative for what MAME says.

They disagree constantly and legitimately: MAME abstracts parts away, and one board revision fits a part
another does not. Forcing them into one table would require a `source` discriminator and a precedence rule
baked into the key — exactly the fancy the maintainer rejected.

**How a machine inherits its system's BOM without duplicating rows.** It does not inherit; the view
`v_machine_bom` unions them, preferring the machine's own row per chip:

```sql
SELECT mc.machine_id, mc.chip_id, mc.mame_tag AS role, mc.quantity, mc.clock_hz, 'machine' AS via
FROM machine_chip mc
UNION ALL
SELECT vms.machine_id, sc.chip_id, sc.role_id, sc.quantity, sc.clock_hz, 'system'
FROM v_machine_system vms
JOIN system_chip sc ON sc.system_id = vms.system_id
WHERE NOT EXISTS (SELECT 1 FROM machine_chip m2
                  WHERE m2.machine_id = vms.machine_id AND m2.chip_id = sc.chip_id);
```

Zero duplicated rows on disk; the `via` column tells the reader where each row came from. The dual runs the
other way too: `v_system_chip_effective` lets a system with no curated BOM yet borrow the chips MAME observed
on its machines, so a curator gets useful coverage from a driver rule alone and refines from there.

**Machines cannot be created by hand.** v1 had `create: true` overlays minting `custom:` machines. Deleted.
`machine` is MAME's vocabulary; if MAME does not have the hardware, the thing you have is a documented board
with a chip list, which is a `system` plus `system_chip` rows. This deletes the `custom:` id namespace, the
`create` flag, and merge-into-`{}` semantics. The accepted limitation: a specific PCB variant absent from
MAME cannot be recorded at title granularity. Adding a curated `machine` source later is additive.

### 1.8 Decision (b): one `implementation` table, two typed junctions

**Decision: one table. `system_implementation` does not exist. The target is not polymorphic — it is two
foreign keys in two junction tables.**

The three candidates and why the third wins:

| Option                                                                  | Referential integrity                            | Verdict                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two tables (`implementation`, `system_implementation`)                  | Full                                             | Rejected. Duplicates the entire column set (kind, project, license, language, accuracy, verified, notes) and duplicates four child tables — `*_path`, `*_platform`. The same attributes in two tables is the normalization smell, and it is more machinery, not less. |
| One table, polymorphic `(target_kind, target_id)`                       | **None.** SQLite cannot FK a polymorphic column. | Rejected outright. It would force hand-written dangling-reference checks — precisely the work `PRAGMA foreign_key_check` already does for free.                                                                                                                       |
| One table, targets in `implementation_chip` and `implementation_system` | Full — both are ordinary FKs                     | **Chosen.**                                                                                                                                                                                                                                                           |

An exclusive-arc variant (nullable `chip_id` and `system_id` on `implementation` with
`CHECK ((chip_id IS NULL) <> (system_id IS NULL))`) preserves FKs and was the near-miss. It loses to the
junctions because `implementation_chip` must be N:M anyway — one IP legitimately claims several chips — so
the arc's `chip_id` column would be redundant with the junction it cannot replace.

**The trade-off, stated plainly.** Two things SQLite can no longer enforce:

1. _"An implementation targets at least one thing."_ A row with no junction rows is legal. It is a build
   warning (`UNTARGETED_IMPLEMENTATION`), not a failure.
2. _"Only system-level implementations run machines."_ `implementation_machine` is structurally open to
   chip-level rows. This is deliberate rather than merely tolerated: the fact "this implementation runs these
   machines" is well-formed for any implementation and simply happens to be empty for chip-level ones. That
   is the maintainer's "allow for generic use of facts". A build warning flags the suspicious case.

What this buys: adding an `implementation_kind` row is the entire cost of modelling a new way of realizing
hardware. FPGA HDL is not privileged anywhere in the schema — it is a string in one column, and the only
places that name it are the coverage views and the queries in §6.

### 1.9 Deviations from the proposed table set

| Proposed                                   | Delivered                                                  | Why                                                                                                                                                                                                      |
| ------------------------------------------ | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chip_mame_device`                         | `mame_device`                                              | It holds ignore rows that reference no chip, and its PK is the device name alone (encoding `device → chip`). Naming it after `chip` would misdescribe both facts.                                        |
| `chip_role` on both BOM tables             | `chip_role` on `system_chip` only; `machine_chip.mame_tag` | Curated roles are a controlled vocabulary worth a lookup. MAME tags are an open set of thousands of generated strings; forcing them through a curated table would mint a lookup row per tag for no gain. |
| `implementation` + `system_implementation` | `implementation` alone                                     | §1.8.                                                                                                                                                                                                    |
| `system_implementation_machine`            | `implementation_machine`                                   | §1.8.                                                                                                                                                                                                    |
| `system_implementation_implementation`     | `implementation_dependency`                                | §1.8; self-referencing, so a core may consume a core.                                                                                                                                                    |
| —                                          | **added** `manufacturer_alias`                             | Resolves MAME's free-text manufacturer into the lookup without curating 5,000 strings by hand, and doubles as a search alias.                                                                            |
| —                                          | **added** `chip_family`                                    | `family` is purely a _grouping_ attribute; as free text one misspelling silently splits the group. (`package` stays free text — see §2.4.)                                                               |
| —                                          | **added** `system_name`                                    | Systems need aliases (`CPS-1` / `Capcom Play System`) for the same reasons chips do; mirrors `chip_name` exactly rather than inventing a mechanism.                                                      |
| —                                          | **added** `machine_unmapped_device`                        | Replaces the whole `unknown:*` stub convention with a table, and makes the curation worklist a view.                                                                                                     |
| —                                          | **added** `dataset_meta`                                   | Build facts that were redundantly stamped on every machine row in v1.                                                                                                                                    |
| —                                          | **added** `machine_correction`, `machine_chip_correction`  | §5, replacing the overlay merge algebra.                                                                                                                                                                 |
| —                                          | **added** `machine_system`                                 | Per-machine system assignment. One driver `.cpp` legitimately hosts several systems, so `system_driver` is a bulk default and this is the structural exception — an assignment, not a correction (§1.5). |
| —                                          | **added** `threshold`                                      | Typed quality policy. The untyped `dataset_meta` rows it replaces made a rotted threshold silently disable its own gate (§1.5).                                                                          |
| `core` (PLAN §3.4)                         | **deleted**                                                | A core is an `implementation` of kind `fpga_hdl` with a row in `implementation_system`.                                                                                                                  |
| `platform_family` (PLAN §3.5)              | **deleted**                                                | It _is_ `system`.                                                                                                                                                                                        |
| `aliases.json` (v1 §3.2)                   | **deleted**                                                | `chip_name` and `system_name` already do this. §3.4.                                                                                                                                                     |

---

## 2. Normal-form audit

**Scope.** The object list below is generated from `sqlite_master` after applying `schemas/schema.sql`, not
written by hand, and `pipeline/test/schema.test.ts` fails if the counts in this document, in the DDL's own
header comment, and in `sqlite_master` are not all three equal. Measured: **36 tables, 21 views, 34 explicit
indexes.** Every one of the 36 tables appears in §2.2's key analysis — 22 with a single-column key, 14 with a
composite one — and every view is listed in §1.6 or in the sibling specs that own it
([coverage.md](coverage.md) §3.4, [data-quality.md](data-quality.md) Appendix Q). The previous edition of
this section enumerated a schema that no longer existed, and the tables it silently omitted were exactly
where the surviving 1NF/2NF defects were.

### 2.1 First normal form

> **Rule.** Every attribute holds a single atomic value from its domain. No repeating groups, no arrays, no
> embedded documents, no order-carrying position. Every row is identified by a primary key.

**Compliance.** No column in any of the 36 tables holds a list, a JSON blob, a delimited string, or a nested
object. `STRICT` typing makes this mechanically checkable: every column is `TEXT` or `INTEGER` (there is not a
single `ANY` or `BLOB` column). Every table declares a `PRIMARY KEY`. Every 1:N is a child table with the
parent's key in its own key; every N:M is a junction whose key is exactly the two participating keys.

**Every v1 repeating group and the table that fixes it:**

| v1 violation                                      | Fixed by                                                                                     |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `machine.chips[]`                                 | `machine_chip` (PK `machine_id, mame_tag, chip_id`)                                          |
| `chip.names[]` (order-significant)                | `chip.display_name` for the single-valued name + `chip_name` for the alternates              |
| `chip.datasheet_urls[]`                           | `chip_datasheet` (PK `chip_id, url`)                                                         |
| `chip.mame_devices[]`                             | `mame_device` (PK `mame_device`) — the relation is stored once, in the direction its FD runs |
| `implementation.paths[]` (order = top)            | `implementation_path` (PK `implementation_id, path`) with an explicit `is_top` column        |
| `implementation.target_platforms[]`               | `implementation_platform` (PK `implementation_id, platform_id`)                              |
| `implementation.known_consumers[]`                | `implementation_dependency` read backwards — not stored at all                               |
| `implementation.chip_ids[]`                       | `implementation_chip` (PK `implementation_id, chip_id`)                                      |
| `core.machines[]`                                 | `implementation_machine` (PK `implementation_id, machine_id`)                                |
| `core.platform_families[]`                        | `implementation_system` (PK `implementation_id, system_id`)                                  |
| `equivalences.classes[].chips[]`                  | `chip_equivalence` rows (PK `from_chip_id, to_chip_id`)                                      |
| `equivalences.provides[]`                         | same table, `kind = 'provides'`                                                              |
| `machine.coverage.missing[]`                      | not stored — `v_system_chip_coverage` where `satisfied_via = 'unsatisfied'`                  |
| `platform_families.*.machines[]`                  | `machine_system`                                                                             |
| `platform_families.*.drivers[]`                   | `system_driver` (PK `mame_sourcefile`)                                                       |
| `quality_report.warnings[]`, `unmapped_devices[]` | `v_mame_device_worklist` and the build's own diagnostics; not model data                     |

The subtle 1NF fix is `implementation_path.is_top`. v1 encoded a fact ("this is the top module") as _array
position_, which is not an attribute value at all. Positional encoding is the repeating-group problem wearing
a different hat, and it breaks the moment the array is sorted for determinism.

### 2.2 Second normal form

> **Rule.** 1NF, and every non-key attribute is functionally dependent on the **whole** primary key — no
> attribute depends on a proper subset of a composite key.

**All 22 single-column-key tables satisfy 2NF vacuously** (no proper subset of a one-column key exists):
`accuracy_level`, `chip`, `chip_family`, `chip_function`, `chip_role`, `dataset_meta`, `fpga_platform`,
`hdl_language`, `implementation`, `implementation_kind`, `license`, `machine`, `machine_correction`,
`machine_system`, `mame_device`, `manufacturer`, `manufacturer_alias`, `project`, `system`, `system_driver`,
`system_kind`, `threshold`.

**All 14 composite-key tables**, each non-key attribute checked against the full key:

| Table                       | Key                             | Non-key attributes                         | Depends on the whole key?                                                                                                                                                                                                            |
| --------------------------- | ------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `chip_datasheet`            | (chip_id, url)                  | title                                      | Yes.                                                                                                                                                                                                                                 |
| `chip_equivalence`          | (from_chip_id, to_chip_id)      | kind, note                                 | Yes — both describe the edge, not either endpoint.                                                                                                                                                                                   |
| `chip_name`                 | (chip_id, name)                 | kind                                       | Yes. Whether a string is displayable or a retired id is a property of that string for that chip.                                                                                                                                     |
| `implementation_chip`       | both columns                    | none                                       | Vacuous — pure junction.                                                                                                                                                                                                             |
| `implementation_dependency` | (consumer_id, provider_id)      | note                                       | Yes.                                                                                                                                                                                                                                 |
| `implementation_machine`    | both columns                    | none                                       | Vacuous — pure junction.                                                                                                                                                                                                             |
| `implementation_path`       | (implementation_id, path)       | is_top                                     | Yes.                                                                                                                                                                                                                                 |
| `implementation_platform`   | both columns                    | none                                       | Vacuous — pure junction.                                                                                                                                                                                                             |
| `implementation_system`     | both columns                    | none                                       | Vacuous — pure junction.                                                                                                                                                                                                             |
| `machine_chip`              | (machine_id, mame_tag, chip_id) | clock_hz, quantity                         | **No, and the DDL now says so.** MAME tags are unique within a machine, so the determinant is `(machine_id, mame_tag)` and `chip_id` is functionally dependent on it, not part of it. `ux_machine_chip_tag` restores the real key. ¹ |
| `machine_chip_correction`   | (machine_id, mame_tag, chip_id) | op, clock_hz, quantity, reason, source_url | Same as `machine_chip`, and for the same reason; `ux_machine_chip_correction_tag` is the same fix. ¹                                                                                                                                 |
| `machine_unmapped_device`   | (machine_id, mame_device)       | quantity                                   | Yes — instances of that device in that machine.                                                                                                                                                                                      |
| `system_chip`               | (system_id, role_id, chip_id)   | quantity, clock_hz, note                   | Yes. The clock of the YM2151 _in the `sound` role of System 16A_ is a fact about all three, and two chips in one role is real on a curated board — two sound parts both at `sound`.                                                  |
| `system_name`               | (system_id, name)               | kind                                       | Yes.                                                                                                                                                                                                                                 |

¹ The previous edition of this table asserted the violation away ("Yes — MAME states the clock per tagged
instance"), and the schema accepted `('outrun','maincpu','m68000')` alongside `('outrun','maincpu','z80')`:
two chips in one socket, which inflated `chips_total` and deflated `satisfied_share` for the whole system.
The declared key stays three columns only because the tagless `:device` sentinel rows have no socket to be
keyed by; every tagged row is keyed by `(machine_id, mame_tag)` through a partial unique index
(§1.3). Note the deliberate contrast with `system_chip`, where the third key column is genuine: a curated
role is a position a board may fill twice, while a MAME tag is a socket that holds one part.

**The v1 2NF violations named in the brief, and their fixes:**

| v1 violation                                                       | Fix                                                                                                     |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `mame_version` repeated on every machine record                    | `dataset_meta` — it depends on the build, not on `machine_id`                                           |
| `manufacturer` free text on every chip / machine / core record     | `chip.manufacturer_id`, `system.manufacturer_id` → `manufacturer`; MAME's string → `manufacturer_alias` |
| `license` free text on every implementation record                 | `implementation.license_id` → `license`                                                                 |
| coverage numbers stored alongside base facts on the machine record | `v_system_coverage_by_kind` — nothing derived is stored                                                 |

One key decision is worth spelling out because it deletes a build gate: **`system_driver`'s key is
`mame_sourcefile` alone, not `(system_id, mame_sourcefile)`.** That is not a claim that
`mame_sourcefile → system_id` holds in the domain — it does not; one driver `.cpp` genuinely hosts several
systems. It is the statement that a driver file has one _default_ system, which makes "two systems claim one
driver as their default" a `UNIQUE` violation instead of a hand-written `FAMILY_CONFLICT` check. The real
per-machine fact lives in `machine_system`, whose key is `machine_id` — the actual determinant — so the
exception costs one row per machine and no prose (§1.5).

### 2.3 Third normal form

> **Rule.** 2NF, and no non-key attribute is transitively dependent on the key — every non-key attribute
> depends on the key, the whole key, and nothing but the key.

Every transitive dependency in v1 was of the form _record → some code → that code's descriptive attributes_.
Each is now a foreign key to the table that owns those attributes:

| Transitive dependency in v1                                        | Now                                                                      |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `chip_id → manufacturer_name → (country, alternate spellings)`     | `chip.manufacturer_id` → `manufacturer`, `manufacturer_alias`            |
| `chip_id → function → (label, description, prospector band)`       | `chip.function_id` → `chip_function`                                     |
| `chip_id → family → (family's manufacturer)`                       | `chip.family_id` → `chip_family` ²                                       |
| `implementation_id → license → (license name, url, OSI status)`    | `implementation.license_id` → `license`                                  |
| `implementation_id → language → (display label)`                   | `implementation.hdl_language_id` → `hdl_language`                        |
| `implementation_id → accuracy → (definition)`                      | `implementation.accuracy_id` → `accuracy_level`                          |
| `implementation_id → platform → (platform label)`                  | `implementation_platform.platform_id` → `fpga_platform`                  |
| `implementation_id → author` (repeated on every implementation)    | `implementation.project_id` → `project.author` — stored once per project |
| `system_chip → role → (role label)`                                | `system_chip.role_id` → `chip_role`                                      |
| `system_id → kind → (kind label)`                                  | `system.kind_id` → `system_kind`                                         |
| `machine_id → platform_family → (family name, manufacturer, kind)` | `v_machine_system` → `system`                                            |

² `chip.manufacturer_id` and `chip_family.manufacturer_id` can legitimately disagree, so this is not a
transitive dependency to eliminate: **second-sourced parts genuinely break `family → manufacturer`.** A Sharp
LH0080 belongs to the Zilog Z80 family and is made by Sharp; forcing the family's manufacturer onto the chip
would record a falsehood. What a constraint cannot do is tell a real second source from a data-entry slip, so
the disagreement raises the warning `CHIP_MANUFACTURER_FAMILY_MISMATCH` (data-quality.md §4) and no
constraint at all. A curator confirms the second source in `chip.notes` and leaves it.

**Stored derived values, all removed.** These were 3NF violations of the worst kind — an attribute dependent
not on the key but on _other rows entirely_, and therefore stale the moment anything changes:

| v1 stored derivation                                                | Now                                                                      |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `machine.coverage.{implemented, mapped_total, percent, confidence}` | `v_system_coverage_by_kind` (coverage.md §3.4)                           |
| `machine.coverage.missing[]`                                        | `v_system_chip_coverage` rows where `satisfied_via = 'unsatisfied'`      |
| `machine.cores[]` (reverse index)                                   | `implementation_machine` read backwards                                  |
| `machine.kind`                                                      | `system.kind_id` via `v_machine_system`                                  |
| `chip.mame_devices[]` (normalized: "derived by inverting the map")  | `mame_device` — the map _is_ the relation; there was never a second fact |
| `implementation.known_consumers[]`                                  | `implementation_dependency` read backwards                               |
| `core.platform_families` (curated ∪ derived union)                  | `implementation_system` ∪ `v_machine_system`, resolved in the query      |
| Prospector rankings                                                 | `v_prospector` + an `ORDER BY`                                           |
| `quality_report.summary.*` counters                                 | aggregate queries over `machine_unmapped_device` and `machine_chip`      |

**Higher normal forms.** The schema is incidentally in BCNF: every table's only determinant is its primary
key. No table has two overlapping candidate keys, which is the usual source of a BCNF violation. There are no
multi-valued dependencies within a single table (the classic 4NF trap — putting `paths` and `platforms` in one
table — is avoided because they are separate tables).

### 2.4 What deliberately stays free text

Normalizing costs a join; a database engineer pays it where it buys something. These columns are not lookups,
by design:

| Column                                                             | Why it stays text                                                                                                                                                                              |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chip.package`                                                     | descriptive, not a grouping facet. No planned query groups by package, and its one derivable attribute (pin count) is in the string. Promoting it later is additive.                           |
| `machine.mame_year`, `machine.mame_manufacturer`                   | source-verbatim MAME data. The normalized facts are `v_machine.year` and `v_machine.manufacturer_id`.                                                                                          |
| `project.author`                                                   | single-valued per project and stored once per project. The v1 defect was repeating it on every implementation; that is fixed. A `person` table buys nothing until authorship gains attributes. |
| `*.note`, `*.notes`, `*.reason`, `*.description`, `resource_notes` | prose. Normalizing prose is not a thing.                                                                                                                                                       |

### 2.5 What this supersedes in the sibling specs

- [coverage.md](coverage.md) §8 (supersession), and
  §10 rules 2/4/7/8 are **void**: there are no classes, so there is nothing to lift, disjoin, or close. Its
  §1, §3, §5.2, §6 and §9 — what the two relations mean, the decision ladder, single-hop soundness, the 2A03
  doctrine, and the mandatory-note contract — remain normative and now apply to `chip_equivalence` rows.
- [taxonomy.md](taxonomy.md) is unaffected: its 26 values become 26 `chip_function` rows and its §5 bands
  become the `prospector_band` column.
- [data-quality.md](data-quality.md) keeps its warning-code registry and thresholds; its metrics become
  queries rather than a stored report envelope.

---

## 3. Identifiers

### 3.1 Decision: readable text slugs, no integer surrogates

Every primary key is the natural, human-readable key. No table has a synthetic integer id.

| Criterion              | Verdict                                                                                                                                                                                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **PR reviewability**   | Decisive. The curated source of truth is JSON in Git, reviewed by humans. `{"chip_id": "ym2151", "role_id": "sound"}` is reviewable; `{"chip_id": 417, "role_id": 9}` is not. Integer surrogates would have to be assigned by the build, so no contributor could write a correct file by hand and no diff would mean anything. |
| **Join cost**          | Not a factor. Text keys with `BINARY` collation compare by `memcmp`; SQLite indexes them as B-trees exactly as it does integers. The dataset is thousands of entities and low hundreds of thousands of junction rows. Quoting the maintainer: "any capable b-tree implementation will be more than enough."                    |
| **ID stability**       | A slug is chosen once by a curator and is meaningful, so it is _less_ likely to need changing than a surrogate whose stability depends on load order. Slugs also appear in URLs, which surrogates could not without a second lookup.                                                                                           |
| **Cost, acknowledged** | A rename touches every referencing file. This is the right trade: renames are rare, `PRAGMA foreign_key_check` makes a missed reference a build failure rather than silent rot, and §3.4 preserves the old URL.                                                                                                                |

`WITHOUT ROWID` on every table means the text key _is_ the storage key — no shadow rowid, no secondary lookup.

### 3.2 Slug grammar

```
slug              ^[a-z0-9]+(?:-[a-z0-9]+)*$                    1–64 characters
identifier        ^[a-z0-9]+(?:[_-][a-z0-9]+)*$                 1–64; implementation_kind.kind_id only
mame_shortname    ^[a-z0-9_]{1,32}$                             machine_id — MAME's own grammar, verbatim
mame_device_key   ^[a-z0-9_]{1,64}$                             mame_device
mame_tag          ^:device$|^[a-z0-9_]+(?:[.:][a-z0-9_]+)*$     machine_chip.mame_tag
spdx_id           ^[A-Za-z0-9.+-]{1,64}$                        license_id (SPDX syntax, or the literal `custom`)
sourcefile        ^[a-z0-9_]+(?:/[a-z0-9_]+)*\.cpp$             system_driver.mame_sourcefile, machine.mame_sourcefile
repo_path         ^[A-Za-z0-9._+-]+(?:/[A-Za-z0-9._+-]+)*$      1–256; implementation_path.path
meta_key          ^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$            1–64; dataset_meta.key, threshold.name
date              ^[0-9]{4}-[0-9]{2}-[0-9]{2}$
country           ^[A-Z]{2}$                                    manufacturer.country (ISO 3166-1 alpha-2)
```

`slug` applies to: `chip_id`, `system_id`, `project_id`, `implementation_id`, and every lookup-table key
except `license_id` and `implementation_kind.kind_id`. All are ASCII, lowercase, case-sensitive; there is no
case folding anywhere.

**One grammar per column, and the two expressions of it are provably equal.** Each grammar above is written
twice — as a `CHECK` in `schemas/schema.sql` and as a `pattern` (plus `minLength`/`maxLength`) in
`schemas/common.schema.json` — because SQLite and JSON Schema are different engines and neither can be
derived from the other. `pipeline/test/schema.test.ts` therefore offers every grammar the same corpus twice,
once to the live DDL and once to the regex, and fails on any string the two disagree about. Three columns
were measured to disagree before this rule was enforced:

| Column                     | Was                                                                              | Now                                                              |
| -------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `implementation_path.path` | `a//b` DDL-rejected / JSON-accepted; `a/` and `a b` DDL-accepted / JSON-rejected | `repo_path`, above: no leading or trailing `/`, no empty segment |
| `dataset_meta.key`         | `a..b` DDL-accepted / JSON-rejected                                              | `meta_key`, above; the DDL gained `NOT GLOB '*..*'`              |
| `schema_version.version`   | `01.2.3` DDL-accepted / JSON-rejected                                            | moot — the table is deleted (see "Change control")               |

**No namespace prefixes.** v1 needed `mame:`, `unknown:`, `core:` and `custom:` because every id lived in one
JSON namespace and could collide. In a relational model, `chip.chip_id` and `machine.machine_id` are columns
of different tables and cannot collide by construction. The table name _is_ the namespace. This deletes v1 §1.2
(reserved prefixes), §2 in full (route derivation, inverse totality, colon escaping in URLs, `ROUTE_COLLISION`)
and the 80-character composite-id limit.

URLs are therefore `/chip/<chip_id>`, `/system/<system_id>`, `/machine/<machine_id>`,
`/implementation/<implementation_id>`, `/project/<project_id>` — every slug is already URL-safe.

### 3.3 Stability guarantee

An identifier that has appeared in any published dataset is **permanent**. It MUST NOT be renamed, re-pointed
at a different real-world subject, or reused. Fixing a bad slug means inserting a new row under a new id,
re-pointing every reference in the same PR (the FKs make this mechanical — the build fails until it is
complete), and recording the old id as an alias.

Two identifiers are exempt because they are not ours to guarantee:

- `machine.machine_id` is MAME's shortname. If MAME renames a machine, the row is deleted and re-added on the
  next refresh. Curated references to machines live only in `implementation_machine`, `machine_system` and
  the correction tables, all of which fail the FK check loudly on a MAME bump — which is exactly when a human
  should look.
- `mame_device.mame_device` is likewise MAME's key.

### 3.4 Alias mechanism

**`chip_name` and `system_name` are the alias mechanism. There is no second mechanism and no central alias
file.** A retired id is inserted as a row with `kind = 'retired_id'`; a display alias uses `kind = 'alias'`.
Resolution is one indexed lookup:

```sql
SELECT chip_id FROM chip WHERE chip_id = :s
UNION ALL
SELECT chip_id FROM chip_name WHERE name = :s AND NOT EXISTS (SELECT 1 FROM chip WHERE chip_id = :s);
```

Rules, all enforced at build time (§5.4): a retired id MUST NOT equal any live `chip_id`; aliases MUST NOT
chain (`UNIQUE(name)` plus the previous rule makes resolution single-hop by construction); once shipped, an
alias row MUST NOT be deleted, because deleting one breaks a URL.

**`chip.display_name` and `system.name` sit outside `ux_chip_name_name` / `ux_system_name_name`**, so one
chip's display name may equal another chip's alias and the resolver would answer with the wrong row. The
alternative — folding `display_name` into `chip_name` as a `kind = 'display'` row policed by a partial unique
index — was rejected in one sentence: it would trade a `NOT NULL` single-valued column for a nullable outer
join and a mandatory second row per chip, buying at-most-one where the column already guarantees exactly-one.
The collision is instead caught by one query, exactly as the cross-table `RETIRED_ID_COLLISION` check already
is, and reported as `CHIP_NAME_COLLISION` / `SYSTEM_NAME_COLLISION` (data-quality.md §4).

`project` and `implementation` get no alias table. Their ids are internal — they are not the primary way a
human refers to the thing, and their reference graph is small enough that an in-PR rename is a mechanical,
FK-verified change. Adding an alias table later is additive.

---

## 4. On-disk storage layout

### 4.1 The rule

Curated JSON in `data/` is the source of truth. `extract/` is regenerated from MAME. `dist/` is build output.
The two invariants:

1. **Every row is flat.** No nested objects, no arrays, no positional encoding. A row object's keys are the
   table's column names.
2. **Every file is a set of _table fragments_.** A curated file is a JSON object whose top-level keys are
   **table names** and whose values are arrays of flat rows. A key is never a field name. The loader is
   therefore: for each file, for each key, insert the rows into that table.

```jsonc
// data/system/sega-system16a.json  — the whole contribution, one file
{
  "system": [
    {
      "system_id": "sega-system16a",
      "name": "Sega System 16A",
      "kind_id": "arcade",
      "manufacturer_id": "sega",
      "year_introduced": 1985,
    },
  ],
  "system_name": [{ "system_id": "sega-system16a", "name": "System 16A", "kind": "alias" }],
  "system_driver": [{ "mame_sourcefile": "sega/segas16a.cpp", "system_id": "sega-system16a" }],
  "system_chip": [
    {
      "system_id": "sega-system16a",
      "role_id": "maincpu",
      "chip_id": "m68000",
      "clock_hz": 10000000,
    },
    { "system_id": "sega-system16a", "role_id": "audiocpu", "chip_id": "z80", "clock_hz": 4000000 },
    { "system_id": "sega-system16a", "role_id": "sound", "chip_id": "ym2151", "clock_hz": 4000000 },
  ],
}
```

**Deviation from the recommended one-file-per-row default, and why.** The recommendation's stated goal is
that "a PR adding a chip touches exactly one new file". Strict one-file-per-row cannot meet it: a chip has
alias rows and datasheet rows, so it would touch three files — or force them into shared files that produce
merge conflicts between unrelated PRs. The bundle form meets the goal exactly, keeps rows flat, keeps the
file→table mapping mechanical, and avoids fourteen directories of near-empty files. It is a _tabular_
document, not the entity document v1 had: there is no field whose value is a sub-entity.

### 4.2 File map

| Path                                           | Tables in the file                                                                                                                                                                                              | Writer   |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `data/lookup/<table>.json`                     | one lookup table each: `manufacturer` (+ `manufacturer_alias`), `license`, `chip_function`, `chip_family`, `chip_role`, `system_kind`, `hdl_language`, `fpga_platform`, `implementation_kind`, `accuracy_level` | curator  |
| `data/chip/<chip_id>.json`                     | `chip`, `chip_name`, `chip_datasheet`                                                                                                                                                                           | curator  |
| `data/system/<system_id>.json`                 | `system`, `system_name`, `system_driver`, `system_chip`                                                                                                                                                         | curator  |
| `data/project/<project_id>.json`               | `project`                                                                                                                                                                                                       | curator  |
| `data/implementation/<implementation_id>.json` | `implementation`, `implementation_chip`, `implementation_system`, `implementation_path`, `implementation_platform`, `implementation_machine`, `implementation_dependency`                                       | curator  |
| `data/mame_device.json`                        | `mame_device`                                                                                                                                                                                                   | curator  |
| `data/chip_equivalence.json`                   | `chip_equivalence`                                                                                                                                                                                              | curator  |
| `data/correction/machine.json`                 | `machine_correction`, `machine_system`                                                                                                                                                                          | curator  |
| `data/correction/machine_chip.json`            | `machine_chip_correction`                                                                                                                                                                                       | curator  |
| `extract/machine.json`                         | `machine`                                                                                                                                                                                                       | pipeline |
| `extract/machine_chip.json`                    | `machine_chip`                                                                                                                                                                                                  | pipeline |
| `extract/machine_unmapped_device.json`         | `machine_unmapped_device`                                                                                                                                                                                       | pipeline |
| `extract/dataset_meta.json`                    | `dataset_meta` (the `mame_version` row)                                                                                                                                                                         | pipeline |
| `dist/bomsquad.sqlite`                         | everything                                                                                                                                                                                                      | pipeline |

**Placement rules.** A child row lives in its parent's file when it has exactly one parent
(`implementation_dependency` belongs to the consumer). A table whose rows span two entities with no natural
owner (`chip_equivalence`) or whose key belongs to neither (`mame_device`) gets its own file. Large generated
tables live under `extract/`, never `data/`, and are never hand-edited.

**Filename rule.** For a per-entity file, the filename stem MUST equal the primary key of the file's single
entity row, and every row in the file MUST carry that key in its parent column. Mismatch is a build failure.

### 4.3 Byte-identical output

**JSON.** UTF-8, no BOM; `\n` newlines; exactly one trailing newline; two-space indentation, one key per line
(`JSON.stringify(v, null, 2)` layout); strict JSON, no comments, no duplicate keys; minimal escaping with
non-ASCII written verbatim.

- **Key order within a row: DDL column order.** Mechanical, self-documenting, trivially lintable against the
  schema, and it makes diffs line up column-wise. (This replaces v1's hoist-then-lexicographic rule, which
  existed because entity documents had no column order to inherit.)
- **Top-level key order within a file:** the entity table first, then the remaining table names bytewise ascending.
- **Row order within an array:** by the table's primary-key columns in declaration order, bytewise ascending.
- **`NULL` columns are omitted**, never written as `null`. `null` has no meaning anywhere in this model.
- All string comparison is bytewise on UTF-8. No locale, no case folding.

**SQLite.** The build MUST produce a byte-identical `.sqlite` from identical inputs. The recipe (verified):

```
<apply schemas/schema.sql — OUTSIDE any transaction; see below>
PRAGMA page_size = 4096;  PRAGMA encoding = 'UTF-8';  PRAGMA journal_mode = DELETE;
PRAGMA foreign_keys = OFF;              -- load in any table order
<insert every table's rows in primary-key order>
PRAGMA foreign_keys = ON;  PRAGMA foreign_key_check;  PRAGMA integrity_check;
ANALYZE;   VACUUM;
```

**`PRAGMA foreign_keys` MUST NOT be executed inside a transaction.** SQLite ignores it between `BEGIN` and
`COMMIT` and reports no error, so a builder that wrapped the DDL for speed would ship a database with no
referential enforcement at all and never find out. `applySchema()` therefore reads the pragma back after
running the DDL and throws if it is not `1`; the regression test opens a connection with foreign keys
explicitly off, applies the schema, and asserts both that the pragma is on and that a dangling insert throws.

The SQLite file header carries no timestamp, and `VACUUM` after in-order inserts normalizes page layout, so
double-build byte-comparison is a valid CI gate (`NONDETERMINISTIC_BUILD`).

**Budget.** `dist/bomsquad.sqlite` MUST NOT exceed 48 MB uncompressed; CI fails otherwise. The site loads the
whole file, so if the budget is ever hit the fix is to split the per-title `machine_chip` detail into a second,
lazily-fetched database — not to invent a chunking format. (`sql.js-httpvfs`, which would allow ranged reads,
is unmaintained since 2022 and MUST NOT be adopted.)

---

## 5. Corrections to generated data

### 5.1 The mechanism

Three tables (§1.5) and one pass, applied after `extract/` is loaded and before any view is read:

```sql
-- 1. remove
DELETE FROM machine_chip WHERE (machine_id, mame_tag, chip_id) IN
  (SELECT machine_id, mame_tag, chip_id FROM machine_chip_correction WHERE op = 'remove');

-- 2. add
INSERT INTO machine_chip (machine_id, mame_tag, chip_id, clock_hz, quantity)
SELECT machine_id, mame_tag, chip_id, clock_hz, COALESCE(quantity, 1)
FROM machine_chip_correction WHERE op = 'add';

-- 3. set (non-key columns only; NULL leaves the existing value alone)
UPDATE machine_chip SET
  clock_hz = COALESCE((SELECT c.clock_hz FROM machine_chip_correction c
                       WHERE c.machine_id = machine_chip.machine_id
                         AND c.mame_tag = machine_chip.mame_tag
                         AND c.chip_id  = machine_chip.chip_id AND c.op = 'set'), clock_hz),
  quantity = COALESCE((SELECT c.quantity FROM machine_chip_correction c
                       WHERE c.machine_id = machine_chip.machine_id
                         AND c.mame_tag = machine_chip.mame_tag
                         AND c.chip_id  = machine_chip.chip_id AND c.op = 'set'), quantity)
WHERE EXISTS (SELECT 1 FROM machine_chip_correction c
              WHERE c.machine_id = machine_chip.machine_id AND c.mame_tag = machine_chip.mame_tag
                AND c.chip_id = machine_chip.chip_id AND c.op = 'set');
```

`machine_correction` and `machine_system` need no pass at all — `v_machine` and `v_machine_system` apply
them with a `COALESCE` and a `CASE`.

The correction tables ship inside `dist/bomsquad.sqlite`. Provenance ("was this row corrected, and why?") is a
`LEFT JOIN` to the correction table, not a stored `source` column — that column would be derivable from other
rows, which is the thing §0 forbids.

### 5.2 Staleness

A correction whose target no longer exists is a **build failure**, exactly as in v1 and for the same reason: a
silently-skipped correction either masks an upstream fix or rots invisibly, and the MAME-bump PR is precisely
where a human should be told. Two of the three cases are free:

| Condition                                                                | Detected by                                                    |
| ------------------------------------------------------------------------ | -------------------------------------------------------------- |
| correction targets a machine that no longer exists                       | `PRAGMA foreign_key_check` — `machine_id` is a real FK         |
| correction names a chip that no longer exists                            | `PRAGMA foreign_key_check` — `chip_id` is a real FK            |
| `op='remove'`/`'set'` matches no row, `op='add'` matches an existing row | one `SELECT` per op, run in the same pass (`STALE_CORRECTION`) |

### 5.3 What was deleted from v1, and why

| v1 mechanism                                             | Status      | Why it is not needed                                                                                                                                                                                                         |
| -------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recursive deep merge of arbitrary JSON documents         | **deleted** | Rows are flat and have primary keys. There is nothing to recurse into; "merge" is `UPDATE … WHERE pk = …`.                                                                                                                   |
| `null` as a delete sentinel (RFC 7386 style)             | **deleted** | `NULL` means unknown, everywhere, with no second meaning. Deleting a row is `op='remove'`; clearing a column is not a supported operation (no field in the correctable set has "unknown" as a meaningful correction target). |
| `$add` / `$remove` / `$append` array wrappers            | **deleted** | Arrays are gone. Adding a BOM row is `op='add'`; removing one is `op='remove'`.                                                                                                                                              |
| Declared keyed-array identity keys (v1 §7.2)             | **deleted** | The identity key of a BOM row is the table's primary key, declared once in the DDL.                                                                                                                                          |
| Overlay application order by filename (`__qualifier`)    | **deleted** | Corrections are rows keyed by their target. One row per target per table; ordering is meaningless. Two corrections for one row is a `UNIQUE` violation instead of an ordering subtlety.                                      |
| `OVERLAY_FORBIDDEN_FIELD` gate (v1 §7.3)                 | **deleted** | The correction tables have only the correctable columns. You cannot patch `mame_sourcefile` because there is nowhere to write it.                                                                                            |
| `create: true` machine minting (v1 §7.6)                 | **deleted** | §1.7 — a board absent from MAME is a `system`.                                                                                                                                                                               |
| Implementation overlays (v1 §7.7, for `known_consumers`) | **deleted** | `known_consumers` is not stored. Curators edit `implementation_dependency` directly, because it is curated data, not generated data.                                                                                         |
| Post-merge re-validation against the entity schema       | **deleted** | The constraints are on the table; an illegal correction fails at `INSERT`/`UPDATE`.                                                                                                                                          |

Roughly 120 lines of specification and an entire merge engine collapse into three tables and three statements.

### 5.4 Build gates

The point of the exercise: most integrity is now free.

| Gate                                                                | Enforced by                                              |
| ------------------------------------------------------------------- | -------------------------------------------------------- |
| Every cross-reference resolves                                      | `PRAGMA foreign_key_check` (**free**)                    |
| No duplicate ids, no duplicate junction rows, no duplicate BOM rows | `PRIMARY KEY` (**free**)                                 |
| One device maps to one chip; one driver maps to one system          | `PRIMARY KEY` on the determinant (**free**)              |
| A device is mapped xor ignored                                      | `CHECK` (**free**)                                       |
| At most one top-level path per implementation                       | partial `UNIQUE` index (**free**)                        |
| No self-edges, no mirrored `equivalent` rows                        | `CHECK` (**free**)                                       |
| Types, ranges, enumerations, boolean domains                        | `STRICT` + `CHECK` (**free**)                            |
| Database is structurally sound                                      | `PRAGMA integrity_check` (**free**)                      |
| Every grammar of §3.2                                               | `CHECK` (**free**) — a `GLOB` conjunction expresses each |
| `CHECK` and JSON `pattern` agree, per column                        | brute-force corpus comparison in the test suite          |
| Foreign keys are actually enforced in the shipped file              | `applySchema()` reads `PRAGMA foreign_keys` back (§4.3)  |
| One chip per MAME socket                                            | partial `UNIQUE` index (**free**)                        |
| Every threshold a quality view reads exists                         | the loader, which fails the build otherwise (§1.5)       |
| Filename stem matches the entity key                                | linter                                                   |
| JSON canonical form (key order, row order, formatting)              | linter                                                   |
| `chip_name`/`system_name` retired ids do not collide with live ids  | one `SELECT` (cross-table, so no `CHECK` can express it) |
| Stale corrections                                                   | one `SELECT` per op (§5.2)                               |
| Implementation with no chip and no system                           | one `SELECT` (warning)                                   |
| Chip-level implementation with `implementation_machine` rows        | one `SELECT` (warning)                                   |
| Byte-identical double build                                         | CI byte-compare                                          |
| `dist/bomsquad.sqlite` ≤ 48 MB                                      | CI                                                       |

---

## 6. The canonical queries

All five run against Appendix A + B. Named parameters use `:name`. These are the acceptance tests for the
schema; the schema is wrong if any of them needs a structural change.

### Q1 — For system X, its chips and how many `fpga_hdl` implementations each has

_Ad-hoc query over the view `v_chip_implementation_count`. This is the maintainer's example, and it is a
three-table join._

```sql
SELECT sc.role_id                            AS role,
       c.chip_id,
       c.display_name,
       c.function_id,
       COALESCE(ic.implementation_count, 0)  AS fpga_hdl_implementations
FROM system_chip sc
JOIN chip c ON c.chip_id = sc.chip_id
LEFT JOIN v_chip_implementation_count ic
       ON ic.chip_id = c.chip_id AND ic.kind_id = 'fpga_hdl'
WHERE sc.system_id = :system_id
ORDER BY sc.role_id, c.chip_id;
```

```
role      | chip_id       | display_name  | function_id | fpga_hdl_implementations
audiocpu  | z80           | Z80           | cpu         | 1
maincpu   | m68000        | MC68000       | cpu         | 1
sound     | ym2151        | YM2151        | sound-fm    | 1
video     | sega-315-5011 | Sega 315-5011 | custom      | 0
```

### Q2 — The Prospector: systems with no `fpga_hdl` core on platform P, ranked by chip coverage

_`v_prospector` is a **VIEW**. It emits one row per (platform, system) with no core, so the caller filters
rather than parameterizing a view SQLite cannot parameterize._

```sql
SELECT p.system_id, s.name,
       p.chips_total, p.chips_satisfied, p.chips_equivalent, p.chips_provided,
       ROUND(100.0 * p.satisfied_share, 1) AS satisfied_pct,
       p.unmapped_device_count, p.confidence
FROM v_prospector p
JOIN system s ON s.system_id = p.system_id
WHERE p.platform_id = :platform_id
ORDER BY p.satisfied_share DESC, p.unmapped_device_count ASC, p.chips_total DESC, p.system_id;
```

`chips_equivalent`, `chips_provided` and `confidence` are available because `v_prospector` reads
`v_system_coverage_by_kind` (coverage.md §3.4) rather than a private FPGA-only copy of the same arithmetic.
The specialised copy could not compute them, and the caller had to join the generic view back in to get them.

`unmapped_device_count` is the confidence signal that replaces v1's `coverage.confidence` enum: a system whose
machines still reference unmapped MAME devices has a coverage percentage that is not yet trustworthy, and
sorting on it keeps honest candidates above flattering ones. Weighting by `chip_function.prospector_band` is
an extra join and an `ORDER BY` expression — it is T6.3's config, not a schema concern.

### Q3 — For a given core, every chip implementation it consumes and the HDL paths behind them

_Ad-hoc, recursive so that a core consuming a core still resolves to leaf HDL. This is the traversal that
replaces v1's hand-maintained `known_consumers[]`._

```sql
WITH RECURSIVE consumed(implementation_id, depth) AS (
  SELECT provider_id, 1 FROM implementation_dependency WHERE consumer_id = :core
  UNION
  SELECT d.provider_id, c.depth + 1
  FROM implementation_dependency d
  JOIN consumed c ON d.consumer_id = c.implementation_id
)
SELECT co.depth, i.implementation_id, i.name,
       ic.chip_id, ip.path, ip.is_top,
       COALESCE(i.repo_url, pr.url) AS repo_url, i.license_id
FROM consumed co
JOIN implementation i        ON i.implementation_id = co.implementation_id
LEFT JOIN project pr         ON pr.project_id = i.project_id
LEFT JOIN implementation_chip ic ON ic.implementation_id = i.implementation_id
LEFT JOIN implementation_path ip ON ip.implementation_id = i.implementation_id
WHERE i.kind_id = 'fpga_hdl'
ORDER BY co.depth, i.implementation_id, ip.is_top DESC, ip.path;
```

```
depth | implementation_id | chip_id | path            | is_top | license_id
1     | fx68k             | m68000  | fx68k.sv        | 1      |
1     | jt51              | ym2151  | hdl/jt51.v      | 1      | GPL-3.0-only
1     | jt51              | ym2151  | hdl/jt51_op.v   | 0      | GPL-3.0-only
1     | t80               | z80     | T80.vhd         | 1      |
```

Reverse direction — "who consumes jt51?", v1's `known_consumers` — is the same table:
`SELECT consumer_id FROM implementation_dependency WHERE provider_id = 'jt51'`.

### Q4 — Chips with no `fpga_hdl` implementation, ranked by how many systems use them

_`v_chip_gap` is a **VIEW**. "No implementation" means *not satisfiable* — a chip whose equivalent has HDL is
not a gap._

```sql
SELECT chip_id, display_name, function_id, prospector_band, system_count, machine_count
FROM v_chip_gap
WHERE kind_id = 'fpga_hdl'
ORDER BY system_count DESC, machine_count DESC, chip_id;
```

`v_chip_gap` carries `kind_id` as a column, so the same view answers "what has MAME not modelled?" with a
different `WHERE`. The kind is the caller's, never the view's.

### Q5 — Coverage for one system, counting `equivalent` and `provides` edges as satisfying

_`v_system_coverage_by_kind` (coverage.md §3.4) is a **VIEW** — it is the entirety of what v1 planned as a
"coverage engine", and it is the only definition of the metric._

```sql
SELECT * FROM v_system_coverage_by_kind WHERE system_id = :system_id AND kind_id = 'fpga_hdl';
```

```
system_id      | chips_total | chips_direct | chips_satisfied | satisfied_share | unmapped_device_count | confidence
sega-system16a | 4           | 3            | 3               | 0.75            | 1                     | medium
```

`chips_direct` counts chips with their own HDL; `chips_satisfied` additionally counts chips reachable through
`v_chip_satisfies`, which walks `equivalent` in both directions and `provides` in the provider→socket
direction only, exactly one hop. Per-chip explanation ("_how_ is this socket satisfied?"):

```sql
SELECT chip_id, satisfied_via, provider_chip_id, chip_confidence
FROM v_system_chip_coverage
WHERE system_id = :system_id AND kind_id = 'fpga_hdl'
ORDER BY chip_id;
```

The `missing[]` list of v1 is the rows of that query where `satisfied_via = 'unsatisfied'`.

### 6.1 Which of these are views

| Query | Form                                                                                                                  |
| ----- | --------------------------------------------------------------------------------------------------------------------- |
| Q1    | ad-hoc, over the view `v_chip_implementation_count`                                                                   |
| Q2    | **VIEW** `v_prospector` (built on `v_system_coverage_by_kind` and `v_system_core`), plus a caller-supplied `ORDER BY` |
| Q3    | ad-hoc — it is a recursive traversal from a parameter, which a view cannot usefully encapsulate                       |
| Q4    | **VIEW** `v_chip_gap`, filtered by `kind_id`                                                                          |
| Q5    | **VIEW** `v_system_coverage_by_kind`, plus `v_system_chip_coverage` for the per-chip explanation                      |

---

## Appendix A — DDL (normative)

The shipped file is `schemas/schema.sql`, which is this DDL plus the constraint tightenings its header
enumerates (grammar `CHECK`s, the partial unique indexes, the index policy). Where the two differ, the
shipped file is the artifact and its header explains each delta; nothing below is looser in a way that
changes a key, a foreign key, or an `ON DELETE`.

```sql
PRAGMA foreign_keys = ON;   -- must not be executed inside a transaction (§4.3)

-- ---------- lookup ----------
CREATE TABLE manufacturer (
  manufacturer_id TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  country         TEXT,
  notes           TEXT
) STRICT, WITHOUT ROWID;

CREATE TABLE manufacturer_alias (
  alias           TEXT PRIMARY KEY,
  manufacturer_id TEXT NOT NULL REFERENCES manufacturer(manufacturer_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE license (
  license_id      TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  url             TEXT,
  is_osi_approved INTEGER NOT NULL CHECK (is_osi_approved IN (0,1))
) STRICT, WITHOUT ROWID;

CREATE TABLE chip_function (
  function_id     TEXT PRIMARY KEY,
  label           TEXT NOT NULL,
  description     TEXT NOT NULL,
  prospector_band TEXT NOT NULL CHECK (prospector_band IN ('hard','medium','soft'))
) STRICT, WITHOUT ROWID;

CREATE TABLE chip_family (
  family_id       TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  manufacturer_id TEXT REFERENCES manufacturer(manufacturer_id) ON DELETE RESTRICT,
  description     TEXT
) STRICT, WITHOUT ROWID;

CREATE TABLE chip_role (
  role_id     TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  description TEXT
) STRICT, WITHOUT ROWID;

CREATE TABLE system_kind (
  kind_id TEXT PRIMARY KEY,
  label   TEXT NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE hdl_language (
  language_id TEXT PRIMARY KEY,
  label       TEXT NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE fpga_platform (
  platform_id TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  notes       TEXT
) STRICT, WITHOUT ROWID;

CREATE TABLE implementation_kind (
  kind_id     TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  description TEXT NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE accuracy_level (
  accuracy_id TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  description TEXT NOT NULL
) STRICT, WITHOUT ROWID;

-- ---------- chips ----------
CREATE TABLE chip (
  chip_id          TEXT PRIMARY KEY,
  display_name     TEXT NOT NULL,
  function_id      TEXT NOT NULL REFERENCES chip_function(function_id) ON DELETE RESTRICT,
  manufacturer_id  TEXT REFERENCES manufacturer(manufacturer_id) ON DELETE RESTRICT,
  family_id        TEXT REFERENCES chip_family(family_id) ON DELETE RESTRICT,
  model            TEXT,
  description      TEXT,
  typical_clock_hz INTEGER CHECK (typical_clock_hz IS NULL OR typical_clock_hz > 0),
  package          TEXT,
  year_introduced  INTEGER CHECK (year_introduced IS NULL OR (year_introduced BETWEEN 1950 AND 2100)),
  notes            TEXT
) STRICT, WITHOUT ROWID;

CREATE TABLE chip_name (
  chip_id TEXT NOT NULL REFERENCES chip(chip_id) ON DELETE CASCADE,
  name    TEXT NOT NULL,
  kind    TEXT NOT NULL CHECK (kind IN ('alias','retired_id')),
  PRIMARY KEY (chip_id, name)
) STRICT, WITHOUT ROWID;
CREATE UNIQUE INDEX ux_chip_name_name ON chip_name(name);

CREATE TABLE chip_datasheet (
  chip_id TEXT NOT NULL REFERENCES chip(chip_id) ON DELETE CASCADE,
  url     TEXT NOT NULL,
  title   TEXT,
  PRIMARY KEY (chip_id, url)
) STRICT, WITHOUT ROWID;

CREATE TABLE mame_device (
  mame_device   TEXT PRIMARY KEY,
  chip_id       TEXT REFERENCES chip(chip_id) ON DELETE RESTRICT,
  ignore_reason TEXT,
  note          TEXT,
  CHECK ((chip_id IS NULL) <> (ignore_reason IS NULL))
) STRICT, WITHOUT ROWID;

CREATE TABLE chip_equivalence (
  from_chip_id TEXT NOT NULL REFERENCES chip(chip_id) ON DELETE CASCADE,
  to_chip_id   TEXT NOT NULL REFERENCES chip(chip_id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('equivalent','provides')),
  note         TEXT NOT NULL,
  PRIMARY KEY (from_chip_id, to_chip_id),
  CHECK (from_chip_id <> to_chip_id),
  CHECK (kind <> 'equivalent' OR from_chip_id < to_chip_id)
) STRICT, WITHOUT ROWID;

-- ---------- hardware ----------
CREATE TABLE system (
  system_id       TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  kind_id         TEXT NOT NULL REFERENCES system_kind(kind_id) ON DELETE RESTRICT,
  manufacturer_id TEXT REFERENCES manufacturer(manufacturer_id) ON DELETE RESTRICT,
  year_introduced INTEGER CHECK (year_introduced IS NULL OR (year_introduced BETWEEN 1950 AND 2100)),
  description     TEXT,
  notes           TEXT
) STRICT, WITHOUT ROWID;

CREATE TABLE system_name (
  system_id TEXT NOT NULL REFERENCES system(system_id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  kind      TEXT NOT NULL CHECK (kind IN ('alias','retired_id')),
  PRIMARY KEY (system_id, name)
) STRICT, WITHOUT ROWID;
CREATE UNIQUE INDEX ux_system_name_name ON system_name(name);

CREATE TABLE system_chip (
  system_id TEXT NOT NULL REFERENCES system(system_id) ON DELETE CASCADE,
  role_id   TEXT NOT NULL REFERENCES chip_role(role_id) ON DELETE RESTRICT,
  chip_id   TEXT NOT NULL REFERENCES chip(chip_id)      ON DELETE RESTRICT,
  quantity  INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  clock_hz  INTEGER CHECK (clock_hz IS NULL OR clock_hz > 0),
  note      TEXT,
  PRIMARY KEY (system_id, role_id, chip_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX ix_system_chip_chip ON system_chip(chip_id);

CREATE TABLE system_driver (
  mame_sourcefile TEXT PRIMARY KEY,
  system_id       TEXT NOT NULL REFERENCES system(system_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE machine (
  machine_id        TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  mame_sourcefile   TEXT NOT NULL,
  mame_year         TEXT,
  mame_manufacturer TEXT,
  clone_count       INTEGER CHECK (clone_count IS NULL OR clone_count >= 1),
  driver_status     TEXT CHECK (driver_status IS NULL OR driver_status IN ('good','imperfect','preliminary')),
  is_bios           INTEGER NOT NULL CHECK (is_bios IN (0,1)),
  is_device         INTEGER NOT NULL CHECK (is_device IN (0,1)),
  is_mechanical     INTEGER NOT NULL CHECK (is_mechanical IN (0,1))
) STRICT, WITHOUT ROWID;
CREATE INDEX ix_machine_sourcefile ON machine(mame_sourcefile);

CREATE TABLE machine_chip (
  machine_id TEXT NOT NULL REFERENCES machine(machine_id) ON DELETE CASCADE,
  mame_tag   TEXT NOT NULL,
  chip_id    TEXT NOT NULL REFERENCES chip(chip_id) ON DELETE RESTRICT,
  clock_hz   INTEGER CHECK (clock_hz IS NULL OR clock_hz > 0),
  quantity   INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  PRIMARY KEY (machine_id, mame_tag, chip_id)
) STRICT, WITHOUT ROWID;
-- The real key of a tagged row: one MAME tag is one socket, and one socket is one chip.
CREATE UNIQUE INDEX ux_machine_chip_tag
  ON machine_chip(machine_id, mame_tag) WHERE mame_tag <> ':device';
CREATE INDEX ix_machine_chip_chip ON machine_chip(chip_id);

CREATE TABLE machine_unmapped_device (
  machine_id  TEXT NOT NULL REFERENCES machine(machine_id) ON DELETE CASCADE,
  mame_device TEXT NOT NULL,
  quantity    INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  PRIMARY KEY (machine_id, mame_device)
) STRICT, WITHOUT ROWID;
CREATE INDEX ix_machine_unmapped_device ON machine_unmapped_device(mame_device);

-- ---------- implementations ----------
CREATE TABLE project (
  project_id TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  url        TEXT,
  author     TEXT,
  notes      TEXT
) STRICT, WITHOUT ROWID;

CREATE TABLE implementation (
  implementation_id         TEXT PRIMARY KEY,
  name                      TEXT NOT NULL,
  kind_id                   TEXT NOT NULL REFERENCES implementation_kind(kind_id)  ON DELETE RESTRICT,
  project_id                TEXT REFERENCES project(project_id)                    ON DELETE RESTRICT,
  repo_url                  TEXT,
  hdl_language_id           TEXT REFERENCES hdl_language(language_id)              ON DELETE RESTRICT,
  license_id                TEXT REFERENCES license(license_id)                    ON DELETE RESTRICT,
  accuracy_id               TEXT REFERENCES accuracy_level(accuracy_id)            ON DELETE RESTRICT,
  verified_against_hardware INTEGER CHECK (verified_against_hardware IS NULL OR verified_against_hardware IN (0,1)),
  resource_notes            TEXT,
  last_reviewed             TEXT CHECK (last_reviewed IS NULL OR
                                        last_reviewed GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  notes                     TEXT,
  -- Original silicon is the part as manufactured, not a codebase (§1.4).
  CHECK (kind_id <> 'original_silicon'
         OR (repo_url IS NULL AND hdl_language_id IS NULL
             AND license_id IS NULL AND accuracy_id IS NULL))
) STRICT, WITHOUT ROWID;

CREATE TABLE implementation_chip (
  implementation_id TEXT NOT NULL REFERENCES implementation(implementation_id) ON DELETE CASCADE,
  chip_id           TEXT NOT NULL REFERENCES chip(chip_id) ON DELETE RESTRICT,
  PRIMARY KEY (implementation_id, chip_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX ix_implementation_chip_chip ON implementation_chip(chip_id);

CREATE TABLE implementation_system (
  implementation_id TEXT NOT NULL REFERENCES implementation(implementation_id) ON DELETE CASCADE,
  system_id         TEXT NOT NULL REFERENCES system(system_id) ON DELETE RESTRICT,
  PRIMARY KEY (implementation_id, system_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX ix_implementation_system_system ON implementation_system(system_id);

CREATE TABLE implementation_path (
  implementation_id TEXT NOT NULL REFERENCES implementation(implementation_id) ON DELETE CASCADE,
  path              TEXT NOT NULL,
  is_top            INTEGER NOT NULL DEFAULT 0 CHECK (is_top IN (0,1)),
  PRIMARY KEY (implementation_id, path)
) STRICT, WITHOUT ROWID;
CREATE UNIQUE INDEX ux_implementation_path_top ON implementation_path(implementation_id) WHERE is_top = 1;

CREATE TABLE implementation_platform (
  implementation_id TEXT NOT NULL REFERENCES implementation(implementation_id) ON DELETE CASCADE,
  platform_id       TEXT NOT NULL REFERENCES fpga_platform(platform_id) ON DELETE RESTRICT,
  PRIMARY KEY (implementation_id, platform_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX ix_implementation_platform_platform ON implementation_platform(platform_id);

CREATE TABLE implementation_machine (
  implementation_id TEXT NOT NULL REFERENCES implementation(implementation_id) ON DELETE CASCADE,
  machine_id        TEXT NOT NULL REFERENCES machine(machine_id) ON DELETE RESTRICT,
  PRIMARY KEY (implementation_id, machine_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX ix_implementation_machine_machine ON implementation_machine(machine_id);

CREATE TABLE implementation_dependency (
  consumer_id TEXT NOT NULL REFERENCES implementation(implementation_id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL REFERENCES implementation(implementation_id) ON DELETE RESTRICT,
  note        TEXT,
  PRIMARY KEY (consumer_id, provider_id),
  CHECK (consumer_id <> provider_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX ix_implementation_dependency_provider ON implementation_dependency(provider_id);

-- ---------- corrections and metadata ----------
CREATE TABLE machine_correction (
  machine_id      TEXT PRIMARY KEY REFERENCES machine(machine_id) ON DELETE CASCADE,
  name            TEXT,
  year            INTEGER CHECK (year IS NULL OR (year BETWEEN 1950 AND 2100)),
  manufacturer_id TEXT REFERENCES manufacturer(manufacturer_id) ON DELETE RESTRICT,
  reason          TEXT NOT NULL,
  source_url      TEXT
) STRICT, WITHOUT ROWID;

CREATE TABLE machine_system (
  machine_id TEXT PRIMARY KEY REFERENCES machine(machine_id) ON DELETE CASCADE,
  system_id  TEXT REFERENCES system(system_id) ON DELETE RESTRICT,   -- NULL = deliberately no system
  reason     TEXT                                                    -- an assignment, not an apology
) STRICT, WITHOUT ROWID;
CREATE INDEX ix_machine_system_system ON machine_system(system_id);

CREATE TABLE machine_chip_correction (
  machine_id TEXT NOT NULL REFERENCES machine(machine_id) ON DELETE CASCADE,
  mame_tag   TEXT NOT NULL,
  chip_id    TEXT NOT NULL REFERENCES chip(chip_id) ON DELETE RESTRICT,
  op         TEXT NOT NULL CHECK (op IN ('add','remove','set')),
  clock_hz   INTEGER CHECK (clock_hz IS NULL OR clock_hz > 0),
  quantity   INTEGER CHECK (quantity IS NULL OR quantity >= 1),
  reason     TEXT NOT NULL,
  source_url TEXT,
  PRIMARY KEY (machine_id, mame_tag, chip_id)
) STRICT, WITHOUT ROWID;
CREATE UNIQUE INDEX ux_machine_chip_correction_tag
  ON machine_chip_correction(machine_id, mame_tag) WHERE mame_tag <> ':device';

CREATE TABLE dataset_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE threshold (
  name  TEXT PRIMARY KEY,
  value REAL NOT NULL CHECK (value >= 0)
) STRICT, WITHOUT ROWID;
```

## Appendix B — Views (normative)

**Creation order.** `v_prospector` and `v_chip_gap` read the four coverage views of
[coverage.md](coverage.md) §3.4, so those must exist first. `schemas/schema.sql` is the assembled whole and
creates all 21 in dependency order; the blocks here are grouped by owning document, not by execution order.

```sql
-- Precedence: a machine_system row wins, then the system_driver default, then no system.
CREATE VIEW v_machine_system AS
SELECT m.machine_id,
       CASE WHEN ms.machine_id IS NOT NULL THEN ms.system_id ELSE sd.system_id END AS system_id
FROM machine m
LEFT JOIN machine_system ms ON ms.machine_id = m.machine_id
LEFT JOIN system_driver sd ON sd.mame_sourcefile = m.mame_sourcefile;

CREATE VIEW v_machine AS
SELECT m.machine_id,
       COALESCE(mc.name, m.name) AS name,
       vms.system_id,
       COALESCE(mc.year, CASE WHEN m.mame_year GLOB '[0-9][0-9][0-9][0-9]'
                              THEN CAST(m.mame_year AS INTEGER) END) AS year,
       COALESCE(mc.manufacturer_id, ma.manufacturer_id) AS manufacturer_id,
       m.mame_sourcefile, m.driver_status, m.clone_count
FROM machine m
LEFT JOIN machine_correction mc  ON mc.machine_id  = m.machine_id
LEFT JOIN v_machine_system vms   ON vms.machine_id = m.machine_id
LEFT JOIN manufacturer_alias ma  ON ma.alias       = m.mame_manufacturer;

CREATE VIEW v_machine_bom AS
SELECT mc.machine_id, mc.chip_id, mc.mame_tag AS role, mc.quantity, mc.clock_hz, 'machine' AS via
FROM machine_chip mc
UNION ALL
SELECT vms.machine_id, sc.chip_id, sc.role_id, sc.quantity, sc.clock_hz, 'system'
FROM v_machine_system vms
JOIN system_chip sc ON sc.system_id = vms.system_id
WHERE NOT EXISTS (SELECT 1 FROM machine_chip m2
                  WHERE m2.machine_id = vms.machine_id AND m2.chip_id = sc.chip_id);

CREATE VIEW v_chip_satisfies AS
SELECT chip_id AS socket_chip_id, chip_id AS provider_chip_id, 'self' AS via FROM chip
UNION ALL
SELECT to_chip_id,   from_chip_id, 'equivalent' FROM chip_equivalence WHERE kind = 'equivalent'
UNION ALL
SELECT from_chip_id, to_chip_id,   'equivalent' FROM chip_equivalence WHERE kind = 'equivalent'
UNION ALL
SELECT to_chip_id,   from_chip_id, 'provides'   FROM chip_equivalence WHERE kind = 'provides';

CREATE VIEW v_chip_implementation_count AS
SELECT ic.chip_id, i.kind_id, COUNT(*) AS implementation_count
FROM implementation_chip ic
JOIN implementation i ON i.implementation_id = ic.implementation_id
GROUP BY ic.chip_id, i.kind_id;

CREATE VIEW v_system_chip_effective AS
SELECT system_id, chip_id, 'curated' AS via FROM system_chip
UNION
SELECT vms.system_id, mc.chip_id, 'mame'
FROM v_machine_system vms
JOIN machine_chip mc ON mc.machine_id = vms.machine_id
WHERE vms.system_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM system_chip sc
                  WHERE sc.system_id = vms.system_id AND sc.chip_id = mc.chip_id);

CREATE VIEW v_system_unmapped AS
SELECT vms.system_id, COUNT(DISTINCT mud.mame_device) AS unmapped_device_count
FROM v_machine_system vms
JOIN machine_unmapped_device mud ON mud.machine_id = vms.machine_id
WHERE vms.system_id IS NOT NULL
GROUP BY vms.system_id;

CREATE VIEW v_mame_device_worklist AS
SELECT mud.mame_device,
       COUNT(DISTINCT mud.machine_id) AS machine_count,
       SUM(mud.quantity)              AS instance_count
FROM machine_unmapped_device mud
GROUP BY mud.mame_device;

-- kind_id is a column, not a filter, so this is reusable; v_prospector supplies the kind.
CREATE VIEW v_system_core AS
SELECT DISTINCT i.kind_id, isy.system_id, ip.platform_id, i.implementation_id
FROM implementation_system isy
JOIN implementation i           ON i.implementation_id  = isy.implementation_id
JOIN implementation_platform ip ON ip.implementation_id = i.implementation_id;
```

The two views below read `v_system_coverage_by_kind` and `v_chip_evidence` (coverage.md §3.4) and are
therefore created after them:

```sql
-- Q2. The one view that is *about* FPGA cores, so the one place a kind filter belongs.
CREATE VIEW v_prospector AS
SELECT p.platform_id, c.system_id, c.chips_total, c.chips_direct, c.chips_equivalent,
       c.chips_provided, c.chips_satisfied, c.satisfied_share, c.unmapped_device_count,
       c.confidence
FROM fpga_platform p
CROSS JOIN v_system_coverage_by_kind c
WHERE c.kind_id = 'fpga_hdl'
  AND NOT EXISTS (SELECT 1 FROM v_system_core f
                  WHERE f.kind_id     = c.kind_id
                    AND f.system_id   = c.system_id
                    AND f.platform_id = p.platform_id);

-- Q4. One row per (kind, chip) no implementation of that kind satisfies.
CREATE VIEW v_chip_gap AS
SELECT ik.kind_id, c.chip_id, c.display_name, c.function_id, cf.prospector_band,
       (SELECT COUNT(DISTINCT sc.system_id)  FROM system_chip  sc WHERE sc.chip_id = c.chip_id) AS system_count,
       (SELECT COUNT(DISTINCT mc.machine_id) FROM machine_chip mc WHERE mc.chip_id = c.chip_id) AS machine_count
FROM implementation_kind ik
CROSS JOIN chip c
JOIN chip_function cf ON cf.function_id = c.function_id
WHERE NOT EXISTS (SELECT 1 FROM v_chip_evidence e
                  WHERE e.kind_id = ik.kind_id AND e.chip_id = c.chip_id);
```

---

## Change control

Spec version is semver. **It is stored once inside the database, as `PRAGMA user_version` (the major
component), written by the DDL itself.** `dataset_meta.schema_version` is a different subject — the
_dataset's_ claim about which schema it was built for — and is written by the build. There is no
`schema_version` table: keeping the same value in three places required a hand-written loader assertion whose
only purpose was to reconcile copies that should never have existed. Adding a table, adding a nullable column, adding a view, or adding a row to a lookup
table is a **minor** bump. Changing a primary key, changing an `ON DELETE` behaviour, making a column
`NOT NULL`, removing anything, or changing the meaning of a `CHECK` value is a **major** bump and requires a
migration note in `docs/versioning.md`.
