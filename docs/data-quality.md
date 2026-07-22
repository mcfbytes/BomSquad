# BOM Squad Data Quality Spec

**Spec version 2.0.0 · Normative**

Companion to [data-model.md](data-model.md) (spec 2.0.0), which owns the schema. Where the two disagree,
data-model.md wins for structure and this document wins for quality semantics — metric definitions, gate
conditions, warning codes, thresholds.

This document is the sole specification T6.4 (integrity checks + quality report) implements from, and the sole
source T8.4 (good-first-mapping issue generator) reads its ranking from. RFC 2119 key words apply.

**The central claim of this rewrite: most of v1's quality machinery is now free.** The database enforces it.
`PRAGMA foreign_key_check` replaces a hand-written eleven-edge dangling-reference checker; `PRIMARY KEY`,
`UNIQUE` and `CHECK` replace the duplicate-id, collision and enum gates. §2 is the ledger of what that deletes.
What is left — §3 (FAIL), §4 (WARN), §5 (the headline metric), §6 (the worklist) — is stated as SQL that runs
against Appendix A/B of data-model.md plus Appendix Q of this document. Every statement in this file has been
executed against Node 24's `node:sqlite` (SQLite 3.51.3) with fixture data.

**Every number this document references lives in
[`pipeline/config/quality-thresholds.json`](../pipeline/config/quality-thresholds.json).** §7 is the
cross-reference: every config key ↔ the section that uses it, both directions, no orphans.

---

## 1. Where quality lives now

| Artifact                   | Contains                                                                 | Consumer                    |
| -------------------------- | ------------------------------------------------------------------------ | --------------------------- |
| the build's exit code      | every FAIL condition (§3)                                                | CI                          |
| `dist/bomsquad.sqlite`     | `v_quality_warning`, `v_quality_instance`, `v_mame_device_worklist` (§8) | the SPA, contributors, T8.4 |
| `dist/quality-report.json` | ~20 scalars: the headline metric, entity counts, warning counts per code | CI gates, badges, the site  |

The database _is_ the artifact (data-model.md §4.3), so a defect list belongs in it as a **view**, not in a
bespoke JSON document. §5 of the v1 spec shipped a 500-entry-per-code array with a truncation protocol and a
`WARNINGS_TRUNCATED` sentinel; the same information is now `SELECT * FROM v_quality_warning`, unbounded,
filterable, joinable to the entity it accuses, and costing zero bytes of payload beyond its own SQL text.
`dist/quality-report.json` survives only because CI and a status badge need a handful of numbers without
opening a database.

---

## 2. Deletion ledger — what the schema now enforces

Every row below was a specified check, a warning code, or a report field in v1. None of it is implemented.

### 2.1 Deleted because a constraint enforces it

| v1 rule                                                            | Now enforced by                                                                                                           |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `DANGLING_REFERENCE` — the eleven-edge table (v1 §5.2), every row  | `PRAGMA foreign_key_check`. Every edge is a declared FK. **Zero lines of code.**                                          |
| `OVERLAY_TARGET_MISSING`                                           | FK on `machine_correction.machine_id` etc. — same check, same pragma.                                                     |
| `DUPLICATE_ID` (all entity types, incl. minted `custom:` machines) | `PRIMARY KEY` on every table.                                                                                             |
| `BOM_KEY_COLLISION`                                                | `PRIMARY KEY (machine_id, mame_tag, chip_id)`.                                                                            |
| `FAMILY_CONFLICT` — a machine claimed by two families              | `PRIMARY KEY (mame_sourcefile)` on `system_driver`: the determinant is the key.                                           |
| `ROUTE_COLLISION`                                                  | Nothing to collide — namespace prefixes and derived routes are deleted (§3.2 dm).                                         |
| `ALIAS_COLLISION` (alias = live id; alias chaining; type mismatch) | `UNIQUE(name)` on `chip_name`/`system_name` + FK to the owning table. One residue survives as a FAIL: §3.3.               |
| `UNKNOWN_IN_CURATED` — grep gate for `"unknown:` under `data/`     | The `unknown:` namespace is deleted. Unmapped devices are `machine_unmapped_device` rows, which cannot appear in `data/`. |
| `SCHEMA_VIOLATION` for type/range/enum/boolean domains             | `STRICT` tables + `CHECK` constraints. What remains for the T1.2 validator is JSON row shape, not values.                 |
| "one device maps to one chip"                                      | `PRIMARY KEY (mame_device)`.                                                                                              |
| "a device is mapped xor ignored"                                   | `CHECK ((chip_id IS NULL) <> (ignore_reason IS NULL))`.                                                                   |
| "at most one top-level path per implementation"                    | partial `UNIQUE INDEX … WHERE is_top = 1`.                                                                                |
| "no self-edges, no mirrored `equivalent` rows"                     | `CHECK (from_chip_id <> to_chip_id)`, `CHECK (kind <> 'equivalent' OR from < to)`.                                        |
| `STALE_REFERENCE` (warning: a curated file used an alias)          | Promoted to free and fatal: a retired name is not a `chip_id`, so referencing it is a FK failure.                         |
| Structural soundness of the published file                         | `PRAGMA integrity_check`.                                                                                                 |

### 2.2 Deleted because the thing it measured no longer exists

| v1 machinery                                                                                                                                                     | Why it is gone                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §8 per-machine `coverage.confidence` (`high`/`medium`/`low`) and its two thresholds                                                                              | Replaced by `v_system_coverage_by_kind.unmapped_device_count` — a count of the actual doubt, not a three-valued opinion derived from it. A derived enum stored on every machine was also a stored derivation (3NF).                               |
| `summary.coverage_confidence_counts`                                                                                                                             | Roll-up of the above.                                                                                                                                                                                                                             |
| §3 completeness engine: `completeness_fields.<entity>` × 6 entity lists, the mean-of-per-record-ratios formula, `predicate(f, r)`, the `kind_known` pseudo-field | A JSON list of column names is a second copy of the DDL that drifts from it silently. Completeness is now `COUNT(*) FILTER (WHERE col IS NULL)` per column, written once in SQL (§8, `v_quality_completeness`), and the columns are the schema's. |
| `completeness_fields.core`, `.platform_family`                                                                                                                   | `core` and `platform_family` are not entities any more (data-model.md §1.8/§1.9).                                                                                                                                                                 |
| `chip_required_metadata` config list                                                                                                                             | Two columns named in one view predicate (§4). A config key that can only ever hold the same two strings is not configuration.                                                                                                                     |
| `unmapped_devices[]` + `sample_machines[]` in the report                                                                                                         | `v_mame_device_worklist` (data-model.md Appendix B) plus §6's query. It was a repeating group in a JSON document — the exact 1NF fault this rebuild exists to remove.                                                                             |
| `warning_cap_per_code` + `WARNINGS_TRUNCATED`                                                                                                                    | Warnings are rows in a view. There is no array to truncate and no chunk budget to protect.                                                                                                                                                        |
| `CHUNK_OVER_BUDGET` and the re-sharding rules                                                                                                                    | There are no chunks. One database, one size budget (§3.1).                                                                                                                                                                                        |
| `mame_version` per report entity / per machine                                                                                                                   | `dataset_meta`.                                                                                                                                                                                                                                   |
| `distinct_devices_*` five-member block                                                                                                                           | Three numbers from `v_quality_device` (§5.4), reported but explicitly secondary.                                                                                                                                                                  |

### 2.3 Retained, but relocated

| v1 rule                    | Now                                                                                           |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| `SLUG_INVALID`             | data-model.md §5.4 linter gate (SQLite `GLOB` cannot express the grammar). Not restated here. |
| JSON canonical form        | data-model.md §4.3 linter gate.                                                               |
| Filename stem ↔ entity key | data-model.md §4.2 linter gate.                                                               |
| `STALE_OVERLAY`            | `STALE_CORRECTION` (§3.4), one `SELECT`, no merge engine.                                     |
| `NONDETERMINISTIC_BUILD`   | §3.2, unchanged in spirit and simpler in practice (two files to compare, not two trees).      |

**Net effect:** 6 of v1's 8 failure classes and 3 of its 9 warning codes are gone outright; the eleven-row
dangling-reference table, the overlay gate family, the completeness engine, the confidence classifier and the
warning-truncation protocol are gone with them. What is specified below is **7 FAIL queries** (§3.1–§3.7),
**15 WARN queries** (§4) and one metric (§5).

---

## 3. FAIL conditions

A failure means: exit non-zero, publish nothing, leave `dist/` untouched. Failures are **not** recorded in the
quality report — a report exists only for a build that had none.

These run **after** the load and the correction pass of data-model.md §5.1, against the finished database.
Everything in §2.1 has already run by then, for free. Each query below MUST return **zero rows**; any row is
the failure, and the row itself is the error message.

### 3.1 `DB_OVER_BUDGET`

`dist/bomsquad.sqlite` exceeds `db_max_bytes`. Checked with `stat`, not SQL. Rationale for the value and for
the escape hatch (a second lazily-fetched database, never a chunking format) is data-model.md §4.3; the number
lives in the config file so CI and the doc cannot disagree.

### 3.2 `NONDETERMINISTIC_BUILD`

CI builds twice from a clean tree and compares `sha256sum` of `dist/bomsquad.sqlite` and of every file under
`extract/`. The build recipe that makes this valid is data-model.md §4.3.

### 3.3 `RETIRED_ID_COLLISION`

A retired id or alias that is also a live primary key. Cross-table, so no `CHECK` can reach it, and `UNIQUE`
cannot either — the two values live in different tables.

```sql
SELECT 'chip' AS entity, n.name AS name, n.chip_id AS claimed_by
FROM chip_name n JOIN chip c ON c.chip_id = n.name
UNION ALL
SELECT 'system', n.name, n.system_id
FROM system_name n JOIN system s ON s.system_id = n.name
ORDER BY 1, 2;
```

### 3.4 `STALE_CORRECTION`

A correction whose target moved. Two of the three cases (data-model.md §5.2) are already covered by
`foreign_key_check`; this is the third. It MUST run **before** the correction pass, against the freshly loaded
`machine_chip`.

```sql
SELECT c.machine_id, c.mame_tag, c.chip_id, c.op, c.reason
FROM machine_chip_correction c
WHERE (c.op IN ('remove','set')
       AND NOT EXISTS (SELECT 1 FROM machine_chip m
                       WHERE m.machine_id = c.machine_id AND m.mame_tag = c.mame_tag
                         AND m.chip_id = c.chip_id))
   OR (c.op = 'add'
       AND EXISTS (SELECT 1 FROM machine_chip m
                   WHERE m.machine_id = c.machine_id AND m.mame_tag = c.mame_tag
                     AND m.chip_id = c.chip_id))
ORDER BY c.machine_id, c.mame_tag, c.chip_id;
```

### 3.5 `STALE_EXTRACT`

A device recorded as unmapped that the curated dictionary now maps or ignores. `machine_unmapped_device` means
"no `mame_device` row" (data-model.md §1.3); if that stops being true, `extract/` is older than `data/` and
every downstream number — the headline metric included — is computed from a stale denominator. This is the one
invariant that spans the generated and curated halves of the dataset, and no FK can express it, because it
requires the _absence_ of a row in the referenced table.

```sql
SELECT DISTINCT d.mame_device
FROM machine_unmapped_device d
JOIN mame_device md ON md.mame_device = d.mame_device
ORDER BY 1;
```

### 3.6 `DEPENDENCY_CYCLE`

`implementation_dependency` is self-referencing and `CHECK (consumer_id <> provider_id)` only stops the
one-hop case. A longer cycle makes Q3's `WITH RECURSIVE` traversal non-terminating, so this is a correctness
gate on a shipped query, not a style rule.

```sql
WITH RECURSIVE walk(root, node, depth) AS (
  SELECT consumer_id, provider_id, 1 FROM implementation_dependency
  UNION ALL
  SELECT w.root, d.provider_id, w.depth + 1
  FROM walk w
  JOIN implementation_dependency d ON d.consumer_id = w.node
  WHERE w.depth < (SELECT COUNT(*) FROM implementation)
)
SELECT DISTINCT root AS implementation_id FROM walk WHERE node = root ORDER BY 1;
```

The `depth` bound is what makes the detector itself terminate; `COUNT(*)` over `implementation` is the longest
possible acyclic path, so a cycle is always caught before the bound bites.

### 3.7 `DATASET_META_INCOMPLETE`

The four build facts the report and the views read MUST exist. Cheap, and it fails at build time instead of
producing a report with a `null` in it.

```sql
SELECT k.key
FROM (SELECT 'build_date' AS key UNION ALL SELECT 'dataset_version'
      UNION ALL SELECT 'mame_version' UNION ALL SELECT 'schema_version') k
WHERE NOT EXISTS (SELECT 1 FROM dataset_meta m WHERE m.key = k.key)
ORDER BY 1;
```

---

## 4. WARN conditions

All fifteen are branches of one view, `v_quality_warning` (Appendix Q), with the uniform shape:

| Column    | Meaning                                                                                                              |
| --------- | -------------------------------------------------------------------------------------------------------------------- |
| `code`    | SCREAMING_SNAKE code from the registry below. The registry is closed.                                                |
| `subject` | the offending row's primary key, or `NULL` for the one dataset-wide warning.                                         |
| `impact`  | numeric triage magnitude; per-code meaning below; `NULL` where no meaningful magnitude exists (never `0` as filler). |
| `detail`  | one fixed sentence per code. Constant text, so the view is deterministic by construction.                            |

Warnings never break a build. They are queryable in the shipped database and counted in the report.

| Code                                | Fires when                                                                                                                                                                                                                                                                                                                                                                   | `impact`                       | Config                                                     |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------- |
| `MAPPED_INSTANCE_SHARE_LOW`         | `v_quality_instance.mapped_instance_share` < `mapped_instance_share.warn_below`. Exactly one row.                                                                                                                                                                                                                                                                            | the share itself               | `mapped_instance_share.warn_below`                         |
| `UNMAPPED_DEVICE_HIGH_IMPACT`       | a worklist device meets **both** issue-generator minimums. Same predicate as §6, one canonical pair.                                                                                                                                                                                                                                                                         | `instance_count`               | `issue_generator.min_instance_count`, `.min_machine_count` |
| `CHIP_MISSING_METADATA`             | `chip.manufacturer_id IS NULL OR chip.description IS NULL`. PLAN §3.8 names function and manufacturer; `function_id` is `NOT NULL`, so `description` takes the vacated slot as the thing that makes a chip page readable.                                                                                                                                                    | count of missing columns (1–2) | —                                                          |
| `IMPL_UNVERIFIED_LICENSE`           | `implementation.license_id IS NULL` **and `kind_id <> 'original_silicon'`**. Omission is mandated when unverified, so this is the visible cost of honesty, not a prompt to guess.                                                                                                                                                                                            | `NULL`                         | —                                                          |
| `IMPL_UNVERIFIED_ACCURACY`          | `implementation.accuracy_id IS NULL` **and `kind_id <> 'original_silicon'`**.                                                                                                                                                                                                                                                                                                | `NULL`                         | —                                                          |
| `IMPL_STALE_REVIEW`                 | `last_reviewed` older than `stale_review_days` before `dataset_meta.build_date`. A row with no `last_reviewed` is incomplete, not stale, and is not warned here.                                                                                                                                                                                                             | age in whole days              | `stale_review_days`                                        |
| `IMPL_UNTARGETED`                   | no `implementation_chip` and no `implementation_system` row. The check data-model.md §1.8 accepted as the price of two typed junctions.                                                                                                                                                                                                                                      | `NULL`                         | —                                                          |
| `IMPL_MACHINES_WITHOUT_SYSTEM`      | `implementation_machine` rows but no `implementation_system` row. Deliberately a warning: "runs these machines" is well-formed for any implementation, and a chip-level claim to run a title is usually a mis-filed system-level core.                                                                                                                                       | machine row count              | —                                                          |
| `SYSTEM_NO_CHIPS`                   | no row in `v_system_chip_effective` — neither curated nor observed. The system renders as an empty page and cannot appear in the Prospector.                                                                                                                                                                                                                                 | `NULL`                         | —                                                          |
| `SYSTEM_UNMAPPED_SHARE_HIGH`        | the system's unmapped device-instance share exceeds `system_unmapped_share.warn_above`. Its coverage number describes a minority of the board.                                                                                                                                                                                                                               | the share                      | `system_unmapped_share.warn_above`                         |
| `MACHINE_ZERO_MAPPED_CHIPS`         | `v_machine_bom` is empty for the machine — no own rows and no system to inherit from.                                                                                                                                                                                                                                                                                        | unmapped instance count        | —                                                          |
| `EQUIVALENCE_MUTUAL_PROVIDES`       | `a provides b` and `b provides a` both exist. Mutual provision is equivalence; it should be one `equivalent` edge, which `v_chip_satisfies` already walks both ways. Emitted once, on the `from < to` direction.                                                                                                                                                             | `NULL`                         | —                                                          |
| `CHIP_NAME_COLLISION`               | `chip.display_name` equals another chip's `chip_name.name`. `display_name` sits outside `ux_chip_name_name`, so the resolver would answer with a chip other than the one that displays the string (data-model.md §3.4).                                                                                                                                                      | `NULL`                         | —                                                          |
| `SYSTEM_NAME_COLLISION`             | `system.name` equals another system's `system_name.name`. Same gap, same reason.                                                                                                                                                                                                                                                                                             | `NULL`                         | —                                                          |
| `CHIP_MANUFACTURER_FAMILY_MISMATCH` | `chip.manufacturer_id` differs from its `chip_family.manufacturer_id`, both being non-NULL. A **warning, never a constraint**: second-sourced parts genuinely break `family → manufacturer` (a Sharp Z80 is a chip of the Zilog Z80 family), and nothing can tell a real second source from a data-entry slip. Confirm it in `chip.notes` and leave it (data-model.md §2.3). | `NULL`                         | —                                                          |

**Determinism.** The view reads only base tables and `dataset_meta`; `detail` is constant text; no wall-clock
value appears anywhere (`IMPL_STALE_REVIEW` ages against `build_date`). Rebuilding an old commit reproduces the
old warnings exactly. Callers order by `(code, subject)`.

---

## 5. The mapped-instance-share metric

The project's headline curation number (PLAN §3.8). It answers: **of every place MAME says a part sits on a
board, what fraction have we identified?**

### 5.1 The query

```sql
SELECT m.mapped_instances,
       u.unmapped_instances,
       m.mapped_instances + u.unmapped_instances AS total_instances,
       CASE WHEN m.mapped_instances + u.unmapped_instances = 0 THEN 1.0
            ELSE 1.0 * m.mapped_instances / (m.mapped_instances + u.unmapped_instances)
       END AS mapped_instance_share
FROM (SELECT COALESCE(SUM(quantity), 0) AS mapped_instances   FROM machine_chip) m
CROSS JOIN
     (SELECT COALESCE(SUM(quantity), 0) AS unmapped_instances FROM machine_unmapped_device) u;
```

That is the whole metric. It is shipped as the view `v_quality_instance` (Appendix Q).

### 5.2 The denominator, precisely

**Device _instances_, not distinct devices — and the machine-count weighting is structural, not a weight term.**

`machine_chip` and `machine_unmapped_device` are both keyed by `machine_id`, so a device present in 500
machines contributes 500 rows and a device present in one contributes one. `SUM(quantity)` — not `COUNT(*)` —
then also counts the two 68000s of a dual-CPU board as two instances, because a two-68000 board really does
need two 68000s implemented. PLAN §3.8's "weighted by machine count" is therefore satisfied by summing over the
per-machine tables; there is no weighting factor to get wrong, and no way for the metric to drift from the data.

Population scope:

- **Only MAME-derived instances.** Both tables are `extract/` output, generated from the filtered machine set
  (data-model.md §4.2). There is no other source of instances — curators cannot mint machines any more.
- **Curated boards do not inflate it.** `system_chip` is deliberately absent from the query. A curated BOM is
  not evidence about MAME's device vocabulary, and letting hand-authored rows raise a number that measures
  automated mapping coverage would reward the wrong work.
- **Corrections do move it**, because they are applied to `machine_chip` before the metric is read. This is
  bounded and auditable — every correction row carries a mandatory `reason`, and
  `SELECT COUNT(*) FROM machine_chip_correction WHERE op = 'add'` is the audit.

### 5.3 What counts in the numerator, and how ignored devices are treated

Numerator: **mapped instances only** — rows in `machine_chip`, each of which exists because a `mame_device` row
resolved to a curated `chip`.

Instances of **explicitly ignored** devices (a `mame_device` row with `ignore_reason`) appear in **neither**
term: the extractor emits no per-machine row for them, so there is nothing in the database to count.

This is a deliberate, documented departure from PLAN §3.8's phrasing "mapped **or explicitly ignored**", and it
is behaviourally equivalent where it matters:

1. **Marking a device ignored still moves the number, in the right direction and by the right amount.** Before
   the ignore row exists, the device is unmapped and its instances sit in the denominator. Adding the ignore
   row removes them from the denominator at the next extract, so the share rises. The incentive PLAN wanted —
   "decide about this device" — is fully preserved. §5.5 shows the arithmetic.
2. **It cannot overstate curation.** `mapped / (mapped + unmapped)` is always ≤
   `(mapped + ignored) / (mapped + ignored + unmapped)`. The published number is the conservative one.
3. **It requires no storage.** Crediting ignored instances in the numerator would mean recording, per machine,
   the things we decided are not there — a table of absences, populated from data no view can re-derive. That
   is exactly the kind of storage this rebuild deleted.

The resulting definition also reads better: _the share of MAME-recorded board silicon that BOM Squad can name._

### 5.4 The secondary, distinct-device number

Reported, never headline. It treats a device used in one machine and a device used in 500 identically, which is
precisely the blindness instance weighting exists to fix.

```sql
SELECT (SELECT COUNT(*) FROM mame_device WHERE chip_id       IS NOT NULL) AS devices_mapped,
       (SELECT COUNT(*) FROM mame_device WHERE ignore_reason IS NOT NULL) AS devices_ignored,
       (SELECT COUNT(DISTINCT mame_device) FROM machine_unmapped_device)  AS devices_unmapped;
```

Shipped as `v_quality_device`. Note the asymmetry that makes it secondary in a second way: the first two counts
come from the dictionary and include devices no filtered machine uses, while the third comes from observation.

### 5.5 Worked example

Dictionary (`mame_device`): `m68000 → m68000`, `z80 → z80`, `ym2151 → ym2151`, `screen → ignore`,
`palette → ignore`. `sega_315_5197` has no row.

Three filtered machines, as the extractor writes them:

`machine_chip` — 7 rows, `quantity = 1` each:

| machine | mame_tag   | chip_id  |
| ------- | ---------- | -------- |
| alpha   | `audiocpu` | `z80`    |
| alpha   | `maincpu`  | `m68000` |
| alpha   | `ymsnd`    | `ym2151` |
| beta    | `audiocpu` | `z80`    |
| beta    | `maincpu`  | `m68000` |
| beta    | `subcpu`   | `m68000` |
| gamma   | `audiocpu` | `z80`    |

`machine_unmapped_device` — 2 rows, `quantity = 1` each:

| machine | mame_device     |
| ------- | --------------- |
| alpha   | `sega_315_5197` |
| gamma   | `sega_315_5197` |

Arithmetic:

```
mapped_instances   = 1+1+1+1+1+1+1 = 7      -- SUM(machine_chip.quantity)
unmapped_instances = 1+1           = 2      -- SUM(machine_unmapped_device.quantity)
total_instances    = 7 + 2         = 9
mapped_instance_share = 7 / 9 = 0.777777… → ROUND(·, 4) = 0.7778
```

`beta` contributes 3 mapped instances from 2 distinct chips: instances count parts, not part numbers.

**The same dataset before `screen` and `palette` were ignored.** With no dictionary rows for them, the
extractor records them as unmapped — `alpha` has `screen` and `palette`, `beta` has `screen`, `gamma` has
`screen`:

```
mapped_instances   = 7
unmapped_instances = 2 + 4 = 6
total_instances    = 13
mapped_instance_share = 7 / 13 = 0.538461… → 0.5385
```

Adding two `ignore` rows — a two-line change to `data/mame_device.json` — moves the headline number from
**0.5385 to 0.7778**. That is the incentive PLAN §3.8 asked for, achieved by shrinking the denominator rather
than by inflating the numerator. (v1's formula would have reported `(7+4)/13 = 0.8462` for the _before_ state,
crediting four decisions that had not yet been made.)

Distinct-device view of the _after_ state: 3 mapped, 2 ignored, 2 unmapped keys observed. The two numbers
differ, and the difference is the point — under key counting, `sega_315_5197` and a device in one obscure clone
are worth the same; under instance weighting, leverage is visible.

---

## 6. Top unmapped devices by impact

The contributor's to-do list, and T8.4's input. `v_mame_device_worklist` (data-model.md Appendix B) already
aggregates it; this is the ranked, filtered read with sample machines attached.

```sql
SELECT w.mame_device,
       w.instance_count,
       w.machine_count,
       (SELECT group_concat(s.machine_id, ' ')
        FROM (SELECT machine_id FROM machine_unmapped_device x
              WHERE x.mame_device = w.mame_device
              ORDER BY machine_id LIMIT 5) s) AS sample_machines
FROM v_mame_device_worklist w
WHERE w.instance_count >= :min_instance_count
  AND w.machine_count  >= :min_machine_count
ORDER BY w.instance_count DESC, w.mame_device ASC
LIMIT :top_n;
```

Parameters bind `issue_generator.min_instance_count`, `.min_machine_count`, `.top_n`. Requires SQLite ≥ 3.44
for the ordered subquery feeding `group_concat`; the pinned browser and Node engines are 3.53 and 3.51.

**Impact = `instance_count`, ties broken by `mame_device` ascending.** No composite score:

- It is already machine-count-weighted by construction (§5.2).
- A contributor can re-derive their position with `SELECT`. A score they cannot reproduce is a score they will
  not trust.
- Weighting by driver status or "interestingness" would encode taste into the one number contributors are
  asked to act on. Weighting belongs in the Prospector (`v_prospector` + an `ORDER BY`), which is advisory.

`sample_machines` is what makes an auto-generated issue researchable — real boards to look up, and a direct
`/machine/<machine_id>` link. Five is a deliberate, fixed number, not a threshold: it is a sentence's worth of
examples, and no build behaviour changes with it.

Every row this query returns also carries an `UNMAPPED_DEVICE_HIGH_IMPACT` warning (§4) — one predicate, two
consumers, guaranteed to agree.

---

## 7. Thresholds

All values live in `pipeline/config/quality-thresholds.json`, keys sorted, one canonical place per value. They
are **starting points chosen from first principles, not measurements** — no full dataset existed when they were
set. T9.1 is the scheduled point at which each is re-derived; a threshold that never fires and one that fires
on everything are equally useless.

| Config key                           | Value      | Used by | Rationale                                                                                                                                                                                                                          |
| ------------------------------------ | ---------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db_max_bytes`                       | `50331648` | §3.1    | 48 MiB, stated exactly in bytes so CI and doc cannot disagree about MB vs MiB. The budget and its escape hatch are argued in data-model.md §4.3; the site loads the whole file, so this is a user-visible cost, not a storage one. |
| `issue_generator.min_instance_count` | `50`       | §4, §6  | Below ~50 instances a device is long-tail work a curator reaches by working the list; an auto-opened issue costs more attention than it saves.                                                                                     |
| `issue_generator.min_machine_count`  | `5`        | §4, §6  | Guards against one machine with 60 instances of one custom part generating a "high impact" issue that helps exactly one board. Impact must be broad _and_ deep.                                                                    |
| `issue_generator.top_n`              | `25`       | §6      | One screen of open issues; matches the Prospector's top-25 framing (TASKS T6.3) and keeps the "good first mapping" label from becoming noise.                                                                                      |
| `mapped_instance_share.target`       | `0.9`      | §9      | The "healthy" band boundary for the site's health widget, so no colour threshold gets hardcoded in Angular. 90% leaves room for genuinely unidentifiable custom silicon, which will never be fully mapped.                         |
| `mapped_instance_share.warn_below`   | `0.7`      | §4      | Matches TASKS T3.1's shipping gate (≥ 70% decided). Below this, board pages are more guess than fact and the project should say so on its own health page.                                                                         |
| `stale_review_days`                  | `365`      | §4      | HDL repos change on a scale of years. An annual re-check catches a license change or a rewrite without generating churn.                                                                                                           |
| `system_unmapped_share.warn_above`   | `0.25`     | §4      | Above a quarter unmapped, a coverage percentage computed on the known remainder describes a minority of the board. A round quarter, not a measurement — a prime T9.1 candidate.                                                    |
| `version`                            | `"2.0.0"`  | §9      | Semver of this threshold set; bumped whenever a value changes, so a report traces to the policy that produced it. Not a threshold; recorded for provenance. Major bump because v1's key set was deleted, not migrated.             |

Nine keys, down from twenty-three. Every key above exists in the file and every key in the file appears above.
Adding a threshold means editing both.

**Thresholds inside the database, in a typed table.** The views in §4 cannot take parameters, so the build
copies every numeric leaf of the config into the `threshold` table — `threshold(name TEXT PRIMARY KEY, value
REAL NOT NULL CHECK (value >= 0))`, data-model.md §1.5 — before creating the views, which read it as
`(SELECT value FROM threshold WHERE name = '…')` with no `CAST`. `version` is not a threshold and goes to
`dataset_meta` as `threshold_version`; `db_max_bytes` is copied for uniformity, though only CI reads it.

**Both of this table's properties exist because the previous design failed open.** Thresholds used to be
untyped `dataset_meta` rows read through a `v_threshold` view that `CAST` text to a number:

- a value that stopped parsing `CAST`ed to `0.0`, so `mapped_instance_share < 0.0` became unsatisfiable and
  `MAPPED_INSTANCE_SHARE_LOW` silently stopped firing — **reproduced**;
- deleting the row made the comparison `NULL`, which is never true, so the gate was simply unreachable —
  **reproduced**.

A gate that disables itself when its configuration rots is worse than no gate, because nobody is watching for
the silence. `REAL NOT NULL CHECK (value >= 0)` makes the first impossible at insert time, and the loader
makes the second impossible at build time: it asserts that every threshold name the shipped views read is
present and fails, naming the missing ones, otherwise. That required set is discovered from the view SQL
rather than maintained beside it, so adding a threshold to a view adds it to the contract with no second
edit. `v_threshold` is deleted.

---

## 8. `dist/quality-report.json`

**Decision: a small flat summary, and nothing that is a list.** Anything with more than one row is a view in
the database.

Justification. v1's report was a bespoke document carrying two unbounded arrays, which forced a truncation
protocol, a sentinel warning code, a per-code cap, a sort-before-truncate rule and a chunk-size gate — five
mechanisms whose only purpose was to make a list fit in a file. The database ships anyway, is indexed, and
answers `WHERE code = 'CHIP_MISSING_METADATA' ORDER BY impact DESC` without any of them. What genuinely needs
to be a file is the handful of scalars CI compares and a badge renders, because opening a 40 MB database to
read one ratio is absurd. So: the file keeps the scalars, the database keeps the rows.

Structure — all members REQUIRED, keys bytewise ascending at every level:

```json
{
  "counts": {
    "chip": 78,
    "implementation": 41,
    "machine": 12043,
    "project": 9,
    "system": 22
  },
  "dataset_version": "0.0.0-dev",
  "db_bytes": 11534336,
  "devices": { "ignored": 2, "mapped": 3, "unmapped": 2 },
  "instances": {
    "mapped": 7,
    "mapped_instance_share": 0.7778,
    "total": 9,
    "unmapped": 2
  },
  "mame_version": "0.288",
  "schema_version": "2.0.0",
  "threshold_version": "2.0.0",
  "warnings_by_code": {
    "CHIP_MISSING_METADATA": 2,
    "IMPL_UNVERIFIED_LICENSE": 2
  }
}
```

- `instances` is `v_quality_instance` with the share `ROUND(·, 4)`; `devices` is `v_quality_device`.
- `warnings_by_code` is `SELECT code, COUNT(*) FROM v_quality_warning GROUP BY code ORDER BY code`. Codes with
  zero rows are **omitted** — the registry in §4 is the list of possible keys, and a JSON object full of zeros
  is noise. A consumer treats a missing key as zero.
- `counts` is one `COUNT(*)` per top-level curated entity. Junction and child tables are not counted; they are
  a `SELECT` away for anyone who cares.
- `db_bytes` is the on-disk size of `dist/bomsquad.sqlite`, recorded so a size regression is visible in the
  diff of the report and not only in a CI log.
- No timestamps, no wall-clock values, no build-host paths. `dataset_version`, `mame_version`,
  `schema_version` are copied verbatim from `dataset_meta`.
- Formatting follows data-model.md §4.3: UTF-8, LF, two-space indent, one trailing newline, ratios via
  `ROUND(x, 4)` computed in SQL so rounding is the database's, not JavaScript's.

The report is validated against `schemas/quality-report.schema.json` (T1.2) before writing. A malformed health
report is a build failure like any other.

---

## 9. Implementation notes for T6.4

- Order: apply `schemas/schema.sql` **outside any transaction** (data-model.md §4.3) → load `extract/` and
  `data/` → §3.4 `STALE_CORRECTION` → correction pass (data-model.md §5.1) → `foreign_key_check` +
  `integrity_check` → load thresholds → §3.3, §3.5, §3.6, §3.7 → `VACUUM` → §3.1 size check → write the
  report → §3.2 double-build compare (CI only). The views of Appendix Q are created by the DDL, so there is
  no separate "create the views" step and no window in which a view could be missing.
- Load `pipeline/config/quality-thresholds.json` once through `loadThresholds()`, which writes the typed
  `threshold` table and fails the build when a threshold the views read is absent; after that, read thresholds
  from the database. Any numeric literal in quality code other than `0`, `1`, the `ROUND` precision and the
  fixed `LIMIT 5` of §6 is a bug.
- The views of Appendix Q are created in the shipped database. Per data-model.md's change-control rule, adding
  views is a **minor** spec bump; record it there when this lands.
- Do not re-implement anything in §2.1. If a check feels necessary, first confirm `foreign_key_check`,
  `integrity_check` and the DDL do not already cover it — they cover more than they look like they do.
- `v_quality_warning`'s `impact` column mixes INTEGER, REAL and NULL. Views are not `STRICT`; consumers MUST
  treat it as a number or null and MUST NOT sort across codes.
- The whole of §3 is "each query returns zero rows". Implement it as one loop over a list of
  (code, sql) pairs, printing the offending rows. That is the entire integrity checker.

---

## Appendix Q — quality views (normative)

Created after the correction pass, against Appendix A + B of data-model.md. Reproduced verbatim from
`schemas/schema.sql`, which is the shipped artifact; verified on SQLite 3.51.3, and every view returns
correct rows against the §5.5 fixture. `v_threshold` is gone — the views read the typed `threshold` table
directly (§7).

```sql
CREATE VIEW v_quality_instance AS
SELECT m.mapped_instances,
       u.unmapped_instances,
       m.mapped_instances + u.unmapped_instances AS total_instances,
       CASE WHEN m.mapped_instances + u.unmapped_instances = 0 THEN 1.0
            ELSE 1.0 * m.mapped_instances / (m.mapped_instances + u.unmapped_instances)
       END AS mapped_instance_share
FROM (SELECT COALESCE(SUM(quantity), 0) AS mapped_instances   FROM machine_chip) m
CROSS JOIN
     (SELECT COALESCE(SUM(quantity), 0) AS unmapped_instances FROM machine_unmapped_device) u;

CREATE VIEW v_quality_device AS
SELECT (SELECT COUNT(*) FROM mame_device WHERE chip_id       IS NOT NULL) AS devices_mapped,
       (SELECT COUNT(*) FROM mame_device WHERE ignore_reason IS NOT NULL) AS devices_ignored,
       (SELECT COUNT(DISTINCT mame_device) FROM machine_unmapped_device)  AS devices_unmapped;

CREATE VIEW v_machine_instance AS
SELECT m.machine_id,
       COALESCE((SELECT SUM(quantity) FROM machine_chip c
                 WHERE c.machine_id = m.machine_id), 0) AS mapped_instances,
       COALESCE((SELECT SUM(quantity) FROM machine_unmapped_device d
                 WHERE d.machine_id = m.machine_id), 0) AS unmapped_instances
FROM machine m;

CREATE VIEW v_system_instance AS
SELECT vms.system_id,
       SUM(mi.mapped_instances)   AS mapped_instances,
       SUM(mi.unmapped_instances) AS unmapped_instances,
       CASE WHEN SUM(mi.mapped_instances) + SUM(mi.unmapped_instances) = 0 THEN 0.0
            ELSE 1.0 * SUM(mi.unmapped_instances)
                 / (SUM(mi.mapped_instances) + SUM(mi.unmapped_instances)) END AS unmapped_share
FROM v_machine_system vms
JOIN v_machine_instance mi ON mi.machine_id = vms.machine_id
WHERE vms.system_id IS NOT NULL
GROUP BY vms.system_id;

CREATE VIEW v_quality_completeness AS
SELECT 'chip' AS entity, 'manufacturer_id' AS column_name,
       COUNT(*) AS rows_total, COUNT(manufacturer_id) AS rows_present FROM chip
UNION ALL SELECT 'chip', 'description',      COUNT(*), COUNT(description)      FROM chip
UNION ALL SELECT 'chip', 'family_id',        COUNT(*), COUNT(family_id)        FROM chip
UNION ALL SELECT 'chip', 'model',            COUNT(*), COUNT(model)            FROM chip
UNION ALL SELECT 'chip', 'package',          COUNT(*), COUNT(package)          FROM chip
UNION ALL SELECT 'chip', 'typical_clock_hz', COUNT(*), COUNT(typical_clock_hz) FROM chip
UNION ALL SELECT 'chip', 'year_introduced',  COUNT(*), COUNT(year_introduced)  FROM chip
UNION ALL SELECT 'chip', 'datasheet',        COUNT(*),
       (SELECT COUNT(DISTINCT chip_id) FROM chip_datasheet) FROM chip
UNION ALL SELECT 'implementation', 'license_id',    COUNT(*), COUNT(license_id)    FROM implementation
UNION ALL SELECT 'implementation', 'accuracy_id',   COUNT(*), COUNT(accuracy_id)   FROM implementation
UNION ALL SELECT 'implementation', 'hdl_language_id', COUNT(*), COUNT(hdl_language_id) FROM implementation
UNION ALL SELECT 'implementation', 'project_id',   COUNT(*), COUNT(project_id)    FROM implementation
UNION ALL SELECT 'implementation', 'repo_url',     COUNT(*), COUNT(repo_url)      FROM implementation
UNION ALL SELECT 'implementation', 'last_reviewed', COUNT(*), COUNT(last_reviewed) FROM implementation
UNION ALL SELECT 'implementation', 'verified_against_hardware', COUNT(*),
       COUNT(verified_against_hardware) FROM implementation
UNION ALL SELECT 'system', 'manufacturer_id', COUNT(*), COUNT(manufacturer_id) FROM system
UNION ALL SELECT 'system', 'year_introduced', COUNT(*), COUNT(year_introduced) FROM system
UNION ALL SELECT 'system', 'description',     COUNT(*), COUNT(description)     FROM system
UNION ALL SELECT 'mame_device', 'note',       COUNT(*), COUNT(note)            FROM mame_device;

CREATE VIEW v_quality_warning AS
SELECT 'MAPPED_INSTANCE_SHARE_LOW' AS code, NULL AS subject,
       ROUND(mapped_instance_share, 4) AS impact,
       'dataset mapped-instance share is below the warn threshold' AS detail
FROM v_quality_instance
WHERE mapped_instance_share <
      (SELECT value FROM threshold WHERE name = 'mapped_instance_share.warn_below')

UNION ALL
SELECT 'UNMAPPED_DEVICE_HIGH_IMPACT', w.mame_device, w.instance_count,
       'unmapped MAME device is above both issue-generator thresholds'
FROM v_mame_device_worklist w
WHERE w.instance_count >=
      (SELECT value FROM threshold WHERE name = 'issue_generator.min_instance_count')
  AND w.machine_count >=
      (SELECT value FROM threshold WHERE name = 'issue_generator.min_machine_count')

UNION ALL
SELECT 'CHIP_MISSING_METADATA', c.chip_id,
       (c.manufacturer_id IS NULL) + (c.description IS NULL),
       'chip is missing manufacturer and/or description'
FROM chip c
WHERE c.manufacturer_id IS NULL OR c.description IS NULL

-- The kind filter is the D10 CHECK read as a warning: original silicon is structurally
-- forbidden a licence and an accuracy, so warning about their absence would emit a
-- finding no curator could ever clear.
UNION ALL
SELECT 'IMPL_UNVERIFIED_LICENSE', i.implementation_id, NULL,
       'implementation has no verified license'
FROM implementation i WHERE i.license_id IS NULL AND i.kind_id <> 'original_silicon'

UNION ALL
SELECT 'IMPL_UNVERIFIED_ACCURACY', i.implementation_id, NULL,
       'implementation has no assessed accuracy level'
FROM implementation i WHERE i.accuracy_id IS NULL AND i.kind_id <> 'original_silicon'

UNION ALL
SELECT 'IMPL_STALE_REVIEW', i.implementation_id,
       CAST(julianday((SELECT value FROM dataset_meta WHERE key = 'build_date'))
            - julianday(i.last_reviewed) AS INTEGER),
       'implementation last_reviewed is older than the staleness threshold'
FROM implementation i
WHERE i.last_reviewed IS NOT NULL
  AND julianday((SELECT value FROM dataset_meta WHERE key = 'build_date'))
      - julianday(i.last_reviewed)
      > (SELECT value FROM threshold WHERE name = 'stale_review_days')

UNION ALL
SELECT 'IMPL_UNTARGETED', i.implementation_id, NULL,
       'implementation targets neither a chip nor a system'
FROM implementation i
WHERE NOT EXISTS (SELECT 1 FROM implementation_chip   x WHERE x.implementation_id = i.implementation_id)
  AND NOT EXISTS (SELECT 1 FROM implementation_system y WHERE y.implementation_id = i.implementation_id)

UNION ALL
SELECT 'IMPL_MACHINES_WITHOUT_SYSTEM', i.implementation_id,
       (SELECT COUNT(*) FROM implementation_machine m WHERE m.implementation_id = i.implementation_id),
       'chip-level implementation claims machines but no system'
FROM implementation i
WHERE EXISTS     (SELECT 1 FROM implementation_machine m WHERE m.implementation_id = i.implementation_id)
  AND NOT EXISTS (SELECT 1 FROM implementation_system  y WHERE y.implementation_id = i.implementation_id)

UNION ALL
SELECT 'SYSTEM_NO_CHIPS', s.system_id, NULL,
       'system has no curated and no observed chips'
FROM system s
WHERE NOT EXISTS (SELECT 1 FROM v_system_chip_effective e WHERE e.system_id = s.system_id)

UNION ALL
SELECT 'SYSTEM_UNMAPPED_SHARE_HIGH', si.system_id, ROUND(si.unmapped_share, 4),
       'system unmapped device-instance share is above the warn threshold'
FROM v_system_instance si
WHERE si.unmapped_share >
      (SELECT value FROM threshold WHERE name = 'system_unmapped_share.warn_above')

UNION ALL
SELECT 'MACHINE_ZERO_MAPPED_CHIPS', m.machine_id,
       (SELECT COALESCE(SUM(quantity), 0) FROM machine_unmapped_device d
        WHERE d.machine_id = m.machine_id),
       'machine has no mapped chips in its effective BOM'
FROM machine m
WHERE NOT EXISTS (SELECT 1 FROM v_machine_bom b WHERE b.machine_id = m.machine_id)

UNION ALL
SELECT 'EQUIVALENCE_MUTUAL_PROVIDES', e.from_chip_id || ' -> ' || e.to_chip_id, NULL,
       'mutual provides edge should be a single equivalent edge'
FROM chip_equivalence e
WHERE e.kind = 'provides'
  AND e.from_chip_id < e.to_chip_id
  AND EXISTS (SELECT 1 FROM chip_equivalence r
              WHERE r.kind = 'provides'
                AND r.from_chip_id = e.to_chip_id
                AND r.to_chip_id   = e.from_chip_id)

-- chip.display_name and system.name sit outside ux_chip_name_name / ux_system_name_name,
-- so one entity's display name may equal another's alias and the resolver would answer
-- with the wrong row. Cross-table, so no UNIQUE index can reach it (data-quality §3.3 has
-- the same shape); one query is the whole check.
UNION ALL
SELECT 'CHIP_NAME_COLLISION', c.chip_id, NULL,
       'chip display_name is another chip''s alias or retired id'
FROM chip c
WHERE EXISTS (SELECT 1 FROM chip_name n WHERE n.name = c.display_name AND n.chip_id <> c.chip_id)

UNION ALL
SELECT 'SYSTEM_NAME_COLLISION', s.system_id, NULL,
       'system name is another system''s alias or retired id'
FROM system s
WHERE EXISTS (SELECT 1 FROM system_name n WHERE n.name = s.name AND n.system_id <> s.system_id)

-- Second-sourced parts genuinely break family -> manufacturer (a Sharp Z80 is a chip of
-- the Zilog Z80 family), so this is a warning that names the disagreement, never a
-- constraint that forbids it (data-model §2.3).
UNION ALL
SELECT 'CHIP_MANUFACTURER_FAMILY_MISMATCH', c.chip_id, NULL,
       'chip manufacturer differs from its family''s manufacturer'
FROM chip c
JOIN chip_family f ON f.family_id = c.family_id
WHERE c.manufacturer_id IS NOT NULL
  AND f.manufacturer_id IS NOT NULL
  AND c.manufacturer_id <> f.manufacturer_id;
```
