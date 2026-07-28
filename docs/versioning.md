# BOM Squad Versioning Policy

**Normative for release and migration process.** Companion to [`data-model.md`](data-model.md),
[`coverage.md`](coverage.md), [`taxonomy.md`](taxonomy.md), and [`data-quality.md`](data-quality.md), each of
which is independently spec-versioned and each of which names this document as the place a major spec bump
gets recorded (data-model.md's "Change control", coverage.md's "Change control"). Where this document
describes what a piece of code does, it must not contradict that code — `pipeline/src/db/schema.ts` in
particular is the source of truth for how the schema's own version is stamped, and is quoted rather than
paraphrased below.

There are **four independent version concepts** in this project. They change for different reasons, at
different rates, and mixing them up is exactly the mistake this document exists to prevent:

| Concept               | Answers                                                   | Format                           | Lives                                                                                                        |
| --------------------- | --------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Schema version**    | What shape is the database?                               | semver (`MAJOR.MINOR.PATCH`)     | `PRAGMA user_version` (major only) + `dataset_meta.schema_version` (full)                                    |
| **Dataset version**   | Which content snapshot was this built from?               | date tag                         | `dataset_meta.dataset_version`                                                                               |
| **MAME version**      | Which MAME release did extraction run against?            | MAME's own string (e.g. `0.288`) | `dataset_meta.mame_version`                                                                                  |
| **Threshold version** | Which quality-policy config produced this report's WARNs? | semver                           | `dataset_meta.threshold_version`, sourced from `pipeline/config/quality-thresholds.json`'s own `version` key |

None of the four is derivable from another. A dataset rebuilt today from the same schema and the same MAME pin
still gets a new dataset version if the curated content changed; a schema bump doesn't imply new MAME data;
retuning a threshold doesn't touch the schema at all.

---

## 1. Schema version (semver)

### 1.1 What it governs

The schema version tracks **structure**: every table, column, key, constraint, and view in `schemas/schema.sql`
— which is to say, everything [`data-model.md`](data-model.md) specifies, plus the domain rules
[`coverage.md`](coverage.md) and [`taxonomy.md`](taxonomy.md) layer on top of specific tables. All four
documents currently read **2.0.0** — the version stamped on the relational rewrite that replaced the nested-
document design (`git d747680`, "Phase 1 (v1, superseded)") with the normalized schema this project ships today
(`git 52144a7`, "Phase 1: normalized relational data model"). They share a version today because they were
rewritten together; nothing requires them to stay in lockstep going forward — each has its own bump rule (§1.2)
and its own entry in the migration log (§5) when it changes.

### 1.2 Bump rules

Quoted from [`data-model.md`](data-model.md)'s "Change control" section, which is authoritative:

> Adding a table, adding a nullable column, adding a view, or adding a row to a lookup table is a **minor**
> bump. Changing a primary key, changing an `ON DELETE` behaviour, making a column `NOT NULL`, removing
> anything, or changing the meaning of a `CHECK` value is a **major** bump and requires a migration note in
> `docs/versioning.md`.

[`coverage.md`](coverage.md) states its own, narrower rule for the two equivalence relations it owns:

> Adding a view, adding a lookup row, or adding a validation warning is a **minor** bump. Changing the
> `evidence_rank` ladder, the confidence rules, the one-third threshold, the transitivity decision, or the
> symmetry storage decision is a **major** bump and requires a migration note in `docs/versioning.md` — every
> one of them silently changes published numbers.

[`taxonomy.md`](taxonomy.md) §7 governs `chip_function` the same way in spirit (adding a row is a pure data
change; removing one requires re-pointing every `chip.function_id` that used it in the same PR; a rename is a
delete plus an insert) but — see §6, below — `chip_function` has no alias table, so a taxonomy rename has no
graceful path the way a chip or system rename does.

A **patch** bump is anything that changes none of the above: fixing a typo in a column comment, clarifying
prose, correcting an example. It does not require a migration-log entry.

### 1.3 Where the version physically lives, and why in two places

**`PRAGMA user_version`** — an integer, carrying the schema's **major** component only. It is written by
`schemas/schema.sql` itself:

```sql
PRAGMA user_version = 2;
```

(`pipeline/src/db/schema.ts` exports this as `SCHEMA_USER_VERSION = 2`.) Because it's baked into the same file
that defines every table, it can never drift from the DDL it describes — there is nothing to keep in sync.
Any SQLite client can read it without knowing anything about this project's schema at all
(`PRAGMA user_version` is a generic SQLite mechanism for exactly this purpose), which is what makes it the
right place for the coarse, load-bearing fact: "is this database even structurally compatible with the code
reading it?"

**`dataset_meta.schema_version`** — a `TEXT` row holding the **full** semver string (`"2.0.0"` today), copied
verbatim into `dist/quality-report.json`. `pipeline/src/db/schema.ts` documents the distinction precisely:

```ts
/**
 * Spec version of `docs/data-model.md` that `schema.sql` implements. A dataset states
 * its own `dataset_meta.schema_version`; this constant is what the build stamps there.
 * The database stores the version once, as `PRAGMA user_version` — there is no
 * `schema_version` table, and therefore nothing to reconcile.
 */
export const SCHEMA_VERSION = '2.0.0';
```

The two are different claims, not two copies of one fact: `PRAGMA user_version` is a property of the **file
format itself** (what SQLite's own tooling can read without opening a single one of this project's tables);
`dataset_meta.schema_version` is the **dataset's own statement**, at build time, of which schema version it
was produced against — the fact a report or a UI wants to display to a human. **There is deliberately no third
`schema_version` table.** Data-model.md §1.5 traces exactly why: a table would need a loader assertion to keep
it from silently disagreeing with the other two, and that assertion is what a rotted threshold table
demonstrated failing (data-quality.md §7) — a reconciliation mechanism whose only job is to catch a drift that
two independent sources of truth make possible in the first place. Read the major component from
`PRAGMA user_version` and the full string from `dataset_meta.schema_version`; there is no fourth place to
check.

### 1.4 Not yet wired up

There is no `pipeline build` command yet (`pipeline/src/cli.ts` recognizes only `validate` and `mame:fetch`),
so nothing in this checkout currently _writes_ `dataset_meta` in a real build.
`pipeline/src/spike/build-fixture-db.ts` is a prototype that inserts a `dataset_meta` row for local
experimentation; it is not the production loader. Populating `dataset_meta` (all four of `mame_version`,
`dataset_version`, `schema_version`, and `threshold_version`, plus `build_date`) from a real build is T6.1's
job. This document specifies the policy
those values must follow once that loader exists; it does not claim the loader exists today.

---

## 2. Dataset version (date tag)

`dataset_meta.dataset_version` identifies **which snapshot of curated + extracted content** a database was
built from — a completely different axis from schema version. Two databases can share `schema_version 2.0.0`
and disagree in every row, because a hundred chips were added between them; two databases can share the exact
same `dataset_version` and, in principle, differ in `schema_version` if the schema changed and nothing else
did (unusual, but not contradictory).

**Format: a calendar date, `YYYY-MM-DD`** (the same `date` grammar `data-model.md` §3.2 already uses for
`chip.year_introduced`-adjacent fields and `implementation.last_reviewed`), optionally suffixed `.N` for a
second build cut on the same day (`2026-08-01.2`). Semver is deliberately _not_ used here: "how much changed"
is not a question a dataset release answers usefully — the questions a consumer actually asks are "is this
newer than the copy I have" and "what date's MAME/curation state does this reflect," both of which a date
answers directly and a semver counter does not.

This is not automated yet — see §1.4. `docs/data-quality.md` §8's illustrative `dist/quality-report.json`
example shows `"dataset_version": "0.0.0-dev"`; that is a placeholder value in that document's example JSON,
not a convention any code implements today. Once a release process exists, its dataset_version should be a
date tag per the format above.

Cadence is intentionally decoupled from the MAME refresh: a dataset release can happen on a curation-only
change (new chips, systems, or implementations, no new MAME pin) or alongside a MAME bump; nothing requires the
two to move together. TASKS T2.6 ("monthly MAME refresh workflow") is the one release trigger currently
planned, and it is not implemented yet either — no scheduled workflow exists under `.github/workflows/` beyond
CI and site deployment as of this writing.

---

## 3. MAME version

`dataset_meta.mame_version` is MAME's **own** version string, verbatim — e.g. `0.288`, the release currently
pinned in `pipeline/config/mame.json`. It is not semver (MAME does not use semver) and is never reformatted,
padded, or reinterpreted; it is exactly what `mame -listxml` or the pinned release tag says. Bumping MAME is
editing one field in `pipeline/config/mame.json` (`pipeline/src/mame/config.ts`'s module doc: "Which MAME
release this dataset is built from lives here and nowhere else, so bumping MAME is one file and one review").
Re-running extraction regenerates `extract/` against the new pin; `dataset_meta.mame_version` moves with it
once the build exists to write it (§1.4).

---

## 4. Threshold version

A fourth, narrower semver, independent of all three above: the `version` key inside
`pipeline/config/quality-thresholds.json`, currently `2.0.0` (data-quality.md §7). It is bumped whenever any
quality threshold value changes (`mapped_instance_share.warn_below`, `system_unmapped_share.warn_above`,
etc.), copied into `dataset_meta.threshold_version` at build time, and carried through to
`dist/quality-report.json`. It tracks quality _policy_, not schema shape or dataset content — a report can
trace exactly which threshold set produced its warnings even if the schema and the underlying data haven't
moved at all.

(The root `package.json`'s own `"version": "0.0.0"` is unrelated to any of this — the npm packages are
`"private": true` and never published; that field has no bearing on schema, dataset, MAME, or threshold
versioning.)

---

## 5. Migration log

Every **major** bump to `data-model.md`, `coverage.md`, `taxonomy.md`, or `data-quality.md` adds a row here, in
the same PR that makes the change, per each document's own change-control rule (§1.2).

| Spec version  | Date       | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Commit                            |
| ------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| 1.0.0 → 2.0.0 | 2026-07-22 | The nested-document model (a `core` table, `data/mappings/equivalences.json`, `data/overlays/`, chunked `dist/site-data/` delivery) was rejected — the maintainer's words were "we are violating 1NF and 2NF in various ways, dumb it down please" — and replaced by the normalized relational schema in `schemas/schema.sql`: 36 tables, 21 views, the `machine_correction` / `machine_chip_correction` / `machine_system` correction tables in place of overlay merge algebra, and one SQLite file (`dist/bomsquad.sqlite`) in place of chunked JSON. See `data-model.md` §1.9 for the full itemized deviation list. | `52144a7` (superseding `d747680`) |

No other major bump has happened yet.

---

## 6. Deprecation path for a slug rename

**Standing rule 5 (`TASKS.md`): never rename a slug once it has appeared in a published dataset.** When a
`chip_id` or `system_id` turns out to be wrong, the fix is not an in-place rename — it's minting a new row
under the corrected id and retiring the old one as an alias. `CONTRIBUTING.md` §6.4 has the contributor-facing
walkthrough; this section states the policy it implements, from `data-model.md` §3.4:

1. A retired id is a row in `chip_name` (or `system_name`) with `kind = 'retired_id'`; a displayable alternate
   name uses `kind = 'alias'`. There is no other alias mechanism and no central alias file.
2. A retired id **MUST NOT** equal any live `chip_id`/`system_id` (checked cross-table — `RETIRED_ID_COLLISION`,
   data-quality.md §3.3 — because no `CHECK` or `UNIQUE` constraint can reach across two tables).
3. Aliases **MUST NOT** chain — `UNIQUE(name)` plus rule 2 makes resolution single-hop by construction; a
   resolver never has to follow more than one redirect.
4. Once shipped, an alias or retired-id row **MUST NOT** be deleted — deleting one breaks a URL that may already
   be bookmarked, linked, or cited.

**This mechanism covers exactly two tables: `chip_id` and `system_id`.** It deliberately does not extend to
every identifier in the schema:

- Lookup-table keys (`chip_function.function_id`, `chip_role.role_id`, `system_kind.kind_id`,
  `manufacturer.manufacturer_id`, and the rest) have no alias table at all. `taxonomy.md` §7 is explicit about
  `chip_function` specifically: "`chip_function` has no alias table; it is not a URL-addressable entity."
  Renaming one of these today means picking correctly the first time, or accepting a hard reference-repoint
  with no forwarding redirect.
- `project_id` and `implementation_id` also have no alias table — `data-model.md` §3.4's reasoning is that
  these ids are internal (not the primary way a human refers to the thing) and the reference graph touching
  them is small enough that an in-PR rename, verified by `PRAGMA foreign_key_check`, is a proportionate fix.
  Adding an alias table for either later is additive — it would not require a schema _change_ to anything that
  currently exists, only a new table — but nothing tracks one today.

A curator choosing a new `chip_id` or `system_id` should therefore treat it as effectively permanent from the
moment of merge; a curator naming a new lookup row, project, or implementation should treat the naming decision
as _more_ permanent still, since there is no repair path if it turns out wrong beyond a manual repoint.

---

## Change control (of this document)

This document is not itself schema-versioned — it's process and policy, not structure. Its own history is the
migration log above (§5), which is the append-only record it exists to keep.
