# BOM Squad Data Quality Spec

**Spec version 1.0.0 · Normative**

Companion to [data-model.md](data-model.md), which fixes the _envelopes_ this document fills in. Where the two disagree, data-model.md wins for structure and this document wins for quality semantics (metric definitions, gate conditions, warning codes, thresholds).

This document is the sole specification T6.4 (integrity checks + quality report) implements from, and the sole source T8.4 (good-first-mapping issue generator) reads its ranking from. RFC 2119 key words apply.

**Every number in this document lives in [`pipeline/config/quality-thresholds.json`](../pipeline/config/quality-thresholds.json).** No threshold, cap, field list, or cadence may be written as a literal in pipeline code. §9 is the cross-reference table: every config key ↔ the section that defines it.

---

## 1. What the quality report is

`dist/quality-report.json` is the project's health dashboard. It answers three questions in one file:

1. **How much of MAME's device vocabulary have we curated?** — `mapped_instance_share` (§4), the headline number.
2. **What is degraded, and where?** — the `warnings` array (§6), one entry per defect, non-breaking.
3. **What should a contributor do next?** — `unmapped_devices` (§7), ranked by impact, feeding auto-generated issues.

It is emitted by stage "quality report" of the pipeline order in data-model.md §9 — after coverage (T6.2), before chunk emission (T6.5). It is written both to `dist/quality-report.json` and as the site-data chunk with logical name `quality-report.json`.

A shipped report **contains only warnings**. Anything failure-grade (§5) exits non-zero and publishes nothing, so there is no `failures` field.

---

## 2. `dist/quality-report.json` — complete structure

Top level (envelope fixed by data-model.md §5.12; all members REQUIRED):

| Field              | Type       | Meaning                                                                                                                                     |
| ------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema_version`   | string     | Semver of this envelope. `1.0.0` for this spec. Tracks the data-model spec version.                                                         |
| `dataset_version`  | string     | Copied verbatim from `manifest.dataset_version` (release-supplied, else `0.0.0-dev`).                                                       |
| `mame_version`     | string     | Copied verbatim from `manifest.mame_version`, e.g. `0.288`.                                                                                 |
| `summary`          | object     | §2.1. The one deliberately open object in the model — members MAY be added by a minor spec bump.                                            |
| `warnings`         | Warning[]  | §2.2. Sorted by (`code`, `subject`, `message`) ascending bytewise; an absent `subject` sorts as the empty string, i.e. first. MAY be empty. |
| `unmapped_devices` | Unmapped[] | §2.3. Sorted by `instance_count` descending, then `key` ascending. MAY be empty.                                                            |

Serialization follows data-model.md §8 without exception: 2-space indent, hoisted key order (`$schema`, `id`, …, then bytewise), integers plain, ratios rounded with `Math.round(x * 10000) / 10000`, percentages with `Math.round(x * 10) / 10`, no timestamps.

### 2.1 `summary`

All members are REQUIRED. Integers are exact counts; ratios are 0–1 rounded to 4 decimal places; percentages are 0–100 rounded to 1 decimal place.

**Instance accounting (§4)** — population is MAME device instances across filtered machines:

| Member                   | Type           | Meaning                                                                                 |
| ------------------------ | -------------- | --------------------------------------------------------------------------------------- |
| `chip_instances_total`   | integer        | Denominator of the headline metric. `= mapped + ignored + unknown` (MUST hold exactly). |
| `chip_instances_mapped`  | integer        | Instances whose lookup key has a device-map **map** entry resolving to a curated chip.  |
| `chip_instances_ignored` | integer        | Instances whose lookup key has a device-map **ignore** entry.                           |
| `chip_instances_unknown` | integer        | Instances with no device-map entry, i.e. minted as `unknown:<key>`.                     |
| `mapped_instance_share`  | number (ratio) | `(mapped + ignored) / total`. **The headline metric.** `1` when `total` is 0.           |

**Device-key accounting** — the same population collapsed to distinct lookup keys (the worklist view). Secondary by design: it treats a device used in one machine and a device used in 500 machines identically, which is why it is _not_ the headline number.

| Member                     | Type           | Meaning                                                                                 |
| -------------------------- | -------------- | --------------------------------------------------------------------------------------- |
| `distinct_devices_total`   | integer        | Distinct lookup keys observed across filtered machines. `= mapped + ignored + unknown`. |
| `distinct_devices_mapped`  | integer        | Distinct keys with a map entry.                                                         |
| `distinct_devices_ignored` | integer        | Distinct keys with an ignore entry.                                                     |
| `distinct_devices_unknown` | integer        | Distinct keys with no entry (= `unmapped_devices.length`).                              |
| `mapped_device_share`      | number (ratio) | `(mapped + ignored) / total`. `1` when `total` is 0.                                    |

**Entity counts and curation reach:**

| Member                                | Type    | Meaning                                                                                    |
| ------------------------------------- | ------- | ------------------------------------------------------------------------------------------ |
| `chips_total`                         | integer | Curated chips (excludes stubs).                                                            |
| `chips_stub`                          | integer | `unknown:` stub chips materialized in dist. Equals `distinct_devices_unknown`.             |
| `cores_total`                         | integer | Normalized core records.                                                                   |
| `cores_unmapped`                      | integer | Cores with an empty `machines` array.                                                      |
| `families_total`                      | integer | Platform families.                                                                         |
| `implementations_total`               | integer | Normalized implementation records.                                                         |
| `implementations_unverified_accuracy` | integer | Implementations with no `accuracy` field.                                                  |
| `implementations_unverified_license`  | integer | Implementations with no `license` field.                                                   |
| `machines_total`                      | integer | Normalized machines in dist (MAME-derived + `custom:`).                                    |
| `machines_with_core`                  | integer | Machines with a non-empty derived `cores` array.                                           |
| `machines_zero_mapped_chips`          | integer | Machines whose post-overlay BOM contains no row with a curated (non-`unknown:`) `chip_id`. |

**Coverage confidence roll-up (§8):**

| Member                       | Type   | Meaning                                                                                                                                                                                                                                                                        |
| ---------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `coverage_confidence_counts` | object | Integers keyed `high`, `medium`, `low` (all three keys always present, zero-valued if empty). Counts machines by their derived `coverage.confidence`. Machines without a `coverage` object are not counted; the three values MUST sum to the number of machines that have one. |

**Completeness (§3):**

| Member                 | Type   | Meaning                                                                                                                                                                       |
| ---------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `completeness_percent` | object | Percentages (1 dp) keyed `chip`, `core`, `device_map`, `implementation`, `machine`, `platform_family` — all six keys always present. `0` when the entity population is empty. |

**Warning roll-up:**

| Member             | Type   | Meaning                                                                                                                                                                                                                                                                                             |
| ------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `warnings_by_code` | object | Warning code → integer count of _emitted_ warnings with that code. Keys sorted; codes with zero emissions are omitted. Counts emitted entries, so a truncated code (§6.3) reports the cap, not the true total; the true total is carried by the accompanying `WARNINGS_TRUNCATED` entry's `impact`. |

### 2.2 `Warning`

| Field     | Type   | Req | Meaning                                                                                                                                                                                        |
| --------- | ------ | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `code`    | string | Req | SCREAMING_SNAKE code from the registry in §6.1. Unregistered codes MUST NOT be emitted.                                                                                                        |
| `message` | string | Req | One human-readable sentence, present tense, naming the concrete defect. MUST be deterministic — no counts that depend on iteration order, no wall-clock dates.                                 |
| `subject` | string | Opt | The entity id (`ym2151`, `mame:outrun`, `core:mister-arcade-outrun`) or, when the defect is about a file rather than an entity, the repo-relative path. Absent only for dataset-wide warnings. |
| `impact`  | number | Opt | Magnitude for sorting/triage in the UI. Per-code meaning is fixed in §6.1; where §6.1 gives none, the field MUST be absent (never `0` as a filler).                                            |

### 2.3 `Unmapped`

One entry per distinct lookup key with no device-map entry — i.e. one entry per `unknown:` stub in the dataset.

| Field             | Type     | Req | Meaning                                                                                                                                                                      |
| ----------------- | -------- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `key`             | string   | Req | The device lookup key (data-model.md §6.2), grammar `^[a-z0-9_]{1,64}$`. The stub's id is `unknown:<key>`.                                                                   |
| `instance_count`  | integer  | Req | ≥ 1. Total unknown instances for this key summed over all filtered machines (§4.2). **This is the impact score** (§7).                                                       |
| `machine_count`   | integer  | Req | ≥ 1. Distinct machines containing at least one instance of this key.                                                                                                         |
| `sample_machines` | string[] | Req | Up to 5 **machine ids** (dist-side, so `mame:outrun`, not `outrun`), sorted bytewise ascending, taken as the first 5 of the full sorted list. Deterministic by construction. |

---

## 3. Completeness dimensions per entity

Completeness measures **curation reach**: of the fields a good record would carry, how many does the average record actually carry. It is reported, never gated — a low number is a backlog, not a defect.

### 3.1 Formula

For an entity type `E` with counted field list `F(E)` (from config key `completeness_fields.<E>`) and record population `P(E)`:

```
present(r)          = |{ f ∈ F(E) : predicate(f, r) }|
completeness(r)     = present(r) / |F(E)|
completeness_pct(E) = round( 100 * ( Σ_{r ∈ P(E)} completeness(r) ) / |P(E)| , 1 dp )
```

It is the **mean of per-record ratios**, not the ratio of totals — every record weighs the same, so one lavishly documented chip cannot mask a hundred bare ones. When `|P(E)| = 0`, the value is `0`.

`predicate(f, r)` is "field `f` is present on `r`", where present means: the key exists, and if the value is a string it is non-empty, and if it is an array it has at least one element. `false` counts as present (an explicitly-`false` `verified_against_hardware` is an assessment, not an absence). One pseudo-field exists — `kind_known` on machines — whose predicate is "`r.kind` is not `unknown`".

Completeness is computed on the **normalized (post-overlay, post-derivation) records** as they appear in dist, so overlay curation is correctly credited.

### 3.2 Populations and counted fields

| Entity | Population | Counted fields (`|F|`) |
|---|---|---|
| `chip` | Curated chips only — **stubs excluded** (`stub: true`); a stub is by definition 0% complete and would only dilute the signal. Stub volume is reported separately as `chips_stub`. | `datasheet_urls`, `description`, `family`, `manufacturer`, `model`, `package`, `typical_clock_hz`, `year_introduced` (8) |
| `implementation` | All normalized implementations. | `accuracy`, `author`, `last_reviewed`, `license`, `paths`, `resource_notes`, `target_platforms`, `verified_against_hardware` (8) |
| `machine` | All normalized machines. | `kind_known` (pseudo-field), `manufacturer`, `platform_family`, `year` (4) |
| `core` | All normalized cores. | `author`, `machines`, `platform_families`, `repo` (4) |
| `platform_family` | All families. | `description`, `kind`, `manufacturer` (3) |
| `device_map` | Every **map** entry in `mame-device-map.json` (ignore entries are excluded: their `reason` is schema-required, so they are always 100%). | `note` (1) |

`device_map` completeness therefore reads as "share of mappings carrying a justification note" — the direct measure of T3.1's acceptance criterion that every non-obvious mapping be justified.

Required fields are never counted (they are guaranteed present by schema validation, so they would only inflate the number by a constant).

---

## 4. The mapped-instance-share metric

The single most important curation number in the project. It answers: **of every place MAME says a chip sits on a board, what fraction have we made a curatorial decision about?** A decision is either "this is chip X" (mapped) or "this is not board silicon" (ignored). No decision is `unknown:`.

### 4.1 Population: instances, weighted by machine count

The denominator is **device instances**, not distinct devices. An instance is one occurrence of a device _within one machine_. A device appearing in 500 machines contributes ≈500 instances; a device appearing once contributes 1. That is precisely what PLAN §3.8's "weighted by machine count" means, and it is the whole point: it makes the metric track the number of _board records_ the project can render honestly, which is what a visitor experiences, rather than the length of the device-map file, which no one experiences.

Scope of the population:

- **Only MAME-derived instances count.** The population is enumerated from the filtered raw machines in `extract/machines.raw.json` — the same filter the BOM build uses. `custom:` machines (overlay-created) contribute nothing: they have no MAME devices and no lookup keys.
- **Enumeration happens at the device-map resolution step — before overlays.** Overlay-added BOM rows are not device instances and are excluded from the denominator; overlay-removed rows are _not_ subtracted from it. Rationale: this metric measures the health of the device map, which has exactly one home (data-model.md §5.6). If a device is not real board silicon, the correction belongs in the map as an `ignore` entry with a reason — where it fixes all 500 machines at once and moves the metric — not in one machine's overlay. Letting per-machine overlays move the headline number would reward the wrong fix.

### 4.2 Enumeration (normative)

For each filtered raw machine `M`, define the **resolution target** of a lookup key `k`:

```
τ(k) = chip_id                 if the device map has a map entry for k
     = "ignore:" + k           if the device map has an ignore entry for k
     = "unknown:" + k          otherwise
```

Alias resolution (data-model.md §3.3) applies to the map's `chip_id` values before this step, as everywhere else.

Then, for each distinct target `τ` occurring in `M`:

```
n_chip(τ, M) = number of M.chips[] elements whose normalize_device_key(name) has target τ
n_ref (τ, M) = number of entries in M.device_refs[] (duplicates counted) whose key has target τ
instances(τ, M) = max( n_chip(τ, M), n_ref(τ, M) )
```

`max` is exactly the dedup-by-subtraction of data-model.md §6.5 in closed form: step 1 emits `n_chip` rows and step 3 emits `max(0, n_ref − n_chip)` more, and `n_chip + max(0, n_ref − n_chip) = max(n_chip, n_ref)`. Applying the same rule to ignored targets — which §6.5 skips because they never become rows — keeps the denominator consistent with the numerator. Two _different_ ignored keys are different targets and are never merged.

Aggregate over all filtered machines and classify by target kind:

```
chip_instances_mapped  = Σ_M Σ_{τ mapped}   instances(τ, M)
chip_instances_ignored = Σ_M Σ_{τ ignored}  instances(τ, M)
chip_instances_unknown = Σ_M Σ_{τ unknown}  instances(τ, M)
chip_instances_total   = mapped + ignored + unknown

mapped_instance_share  = round( (mapped + ignored) / total , 4 dp )    // 1 when total = 0
```

`unknown:` instances are counted in the denominator and **never** in the numerator. They are the entire backlog the metric exists to measure; excluding them would make the number self-congratulatory.

Per-key rollups for §7:

```
instance_count(k) = Σ_M instances("unknown:" + k, M)
machine_count(k)  = |{ M : instances("unknown:" + k, M) ≥ 1 }|
```

### 4.3 Worked example

Device map: `m68000 → m68000`, `z80 → z80`, `ym2151 → ym2151`, `screen → {ignore, reason: "MAME presentation abstraction"}`, `palette → {ignore, …}`. The key `sega_315_5197` has **no entry**.

Three filtered machines:

| Machine | `chips[]` (tag → name)                                                           | `device_refs[]`                                                 |
| ------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `alpha` | maincpu → `M68000`, audiocpu → `Z80`, ymsnd → `YM2151`, custom → `Sega 315-5197` | `m68000`, `z80`, `ym2151`, `sega_315_5197`, `screen`, `palette` |
| `beta`  | maincpu → `M68000`, subcpu → `M68000`, audiocpu → `Z80`                          | `m68000`, `m68000`, `z80`, `screen`                             |
| `gamma` | audiocpu → `Z80`                                                                 | `z80`, `screen`, `sega_315_5197`                                |

Instance counts, `max(n_chip, n_ref)` per target:

| Machine | target                  | n_chip | n_ref | instances | class   |
| ------- | ----------------------- | ------ | ----- | --------- | ------- |
| alpha   | `m68000`                | 1      | 1     | **1**     | mapped  |
| alpha   | `z80`                   | 1      | 1     | **1**     | mapped  |
| alpha   | `ym2151`                | 1      | 1     | **1**     | mapped  |
| alpha   | `unknown:sega_315_5197` | 1      | 1     | **1**     | unknown |
| alpha   | `ignore:screen`         | 0      | 1     | **1**     | ignored |
| alpha   | `ignore:palette`        | 0      | 1     | **1**     | ignored |
| beta    | `m68000`                | 2      | 2     | **2**     | mapped  |
| beta    | `z80`                   | 1      | 1     | **1**     | mapped  |
| beta    | `ignore:screen`         | 0      | 1     | **1**     | ignored |
| gamma   | `z80`                   | 1      | 1     | **1**     | mapped  |
| gamma   | `ignore:screen`         | 0      | 1     | **1**     | ignored |
| gamma   | `unknown:sega_315_5197` | 0      | 1     | **1**     | unknown |

Totals:

```
chip_instances_mapped  = 1 + 1 + 1 + 2 + 1 + 1 = 7
chip_instances_ignored = 1 + 1 + 1 + 1         = 4
chip_instances_unknown = 1 + 1                 = 2
chip_instances_total   = 7 + 4 + 2             = 13

mapped_instance_share  = (7 + 4) / 13 = 11 / 13 = 0.846153846…
                       → round(·, 4 dp)         = 0.8462
```

Serialized as `0.8462` (data-model.md §8.4).

Device-key view of the same data — 6 distinct keys, 3 mapped, 2 ignored, 1 unknown:

```
mapped_device_share = 5 / 6 = 0.8333
```

The two numbers differ, and the difference is the point. Under key counting, mapping `sega_315_5197` and mapping a device that appears in a single obscure clone are worth the same 1/6. Under instance weighting, a device in 500 machines is worth 500× a device in one. Only the instance number tells a contributor where the leverage is.

Resulting `unmapped_devices` entry:

```json
{
  "instance_count": 2,
  "key": "sega_315_5197",
  "machine_count": 2,
  "sample_machines": ["mame:alpha", "mame:gamma"]
}
```

Note `beta` contributes 3 mapped instances from 3 `<chip>` elements but only 2 distinct chips — instances count physical parts, not part numbers, because a two-68000 board really does need two 68000s implemented.

---

## 5. FAIL conditions (build-breaking)

A failure means: exit non-zero, publish nothing, leave `dist/` untouched. The failure codes are registered in data-model.md §9; this section fixes the _conditions_ T6.4 checks, in evaluation order. Every failure message MUST name the file, the field path, and the rule — the T1.6 linter contract.

Failures are **not** recorded in the quality report. A report only exists for a build that had none.

### 5.1 Schema and identity

| Code                 | Condition                                                                                                                                                                                                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SCHEMA_VIOLATION`   | Any JSON file fails its schema from the registry (data-model.md §10), including post-overlay normalized machines and the quality report itself (self-validated before writing).                                                                                                                |
| `SLUG_INVALID`       | An id fails its grammar (data-model.md §1.1); a filename stem does not equal the record's route slug / id; a reserved word (`mame`, `unknown`, `core`, `custom`) is used as a complete bare id; a `custom:` machine slug has no hyphen; a core id's payload does not begin with `<platform>-`. |
| `DUPLICATE_ID`       | The same id is defined by two records of the same entity type (including two overlay `create: true` files minting the same `custom:` id).                                                                                                                                                      |
| `ROUTE_COLLISION`    | Two live ids, or a live id and an alias key, derive the same route within one route space (data-model.md §2.4).                                                                                                                                                                                |
| `ALIAS_COLLISION`    | An alias key equals a live id, or an alias value is itself an alias key (chaining), or the two sides are different entity types.                                                                                                                                                               |
| `UNKNOWN_IN_CURATED` | The literal `"unknown:` appears anywhere under `data/` outside an overlay correct/remove position (data-model.md §6.3). Implemented as a grep gate so it cannot be defeated by a schema gap.                                                                                                   |

### 5.2 Dangling cross-references

`DANGLING_REFERENCE` fires when any edge below does not resolve, **after** single-hop alias resolution. This is the complete edge list; T6.4 MUST check every row.

| #   | Edge                                    | Source field                                                                   | Must resolve to                                                                                                                                                                                                  |
| --- | --------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | machine → chip                          | normalized `machine.chips[].chip_id`                                           | a curated chip in `data/chips/`. `unknown:` refs are exempt — they are minted by the pipeline against a stub it also materializes, so they cannot dangle.                                                        |
| 2   | implementation → chip                   | `implementation.chip_ids[]`                                                    | a curated chip. `unknown:` values are a `UNKNOWN_IN_CURATED` failure, not a dangling one.                                                                                                                        |
| 3   | core → machine                          | `core.machines[]`                                                              | a normalized machine id present in the built dataset (a machine excluded by the extraction filter dangles — that is the intended signal).                                                                        |
| 4   | core → platform family                  | `core.platform_families[]` (curated values only)                               | a family key in `platform-families.json`.                                                                                                                                                                        |
| 5   | equivalence → chip                      | `equivalences.classes[].chips[]`, `provides[].provider`, `provides[].provides` | a curated chip.                                                                                                                                                                                                  |
| 6   | family → machine                        | `platform-families.families[].machines[]`                                      | an extracted machine id.                                                                                                                                                                                         |
| 7   | family → driver                         | `platform-families.families[].drivers[]`                                       | at least one extracted machine whose raw `sourcefile` equals the value. A driver rule matching nothing is dead curation.                                                                                         |
| 8   | device-map → chip                       | `devices[].chip_id` (map entries)                                              | a curated chip.                                                                                                                                                                                                  |
| 9   | implementation-overlay → implementation | overlay `target` in `data/overlays/implementations/`                           | a curated implementation.                                                                                                                                                                                        |
| 10  | alias → entity                          | every value in `aliases.json`                                                  | a live id of the same entity type.                                                                                                                                                                               |
| 11  | overlay → machine                       | overlay `target` in `data/overlays/machines/` without `create: true`           | an extracted or previously-created machine. Reported as **`OVERLAY_TARGET_MISSING`**, not `DANGLING_REFERENCE` — a distinct code because the actionable fix (delete the overlay, or add `create: true`) differs. |

Edge 11's sibling failures — `STALE_OVERLAY` (a correct/remove operation matched nothing, or a correct operation's values already differ) and `OVERLAY_FORBIDDEN_FIELD` (an overlay touched `id`, `source`, `platform_family`, `origin`, or a derived field) — are specified in data-model.md §7.5 and are equally build-breaking. They are listed here so the T6.4 gate inventory is complete.

### 5.3 Structural integrity

| Code                | Condition                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FAMILY_CONFLICT`   | A machine is claimed by two families (two explicit `machines[]` listings, or two driver rules from different families with no explicit override). |
| `BOM_KEY_COLLISION` | Two rows in one normalized machine share (`role`, `chip_id`).                                                                                     |

### 5.4 Output integrity

| Code                     | Condition                                                                                                                                                                                                                                                                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHUNK_OVER_BUDGET`      | Any emitted chunk's gzip size exceeds 256 000 bytes. The emitter re-shards where sharding is defined (machine indexes, machine detail buckets, search chunks) and fails only when a single indivisible chunk — including this quality report — exceeds it. §6.3's warning cap exists so that this report can never be the chunk that trips this gate. |
| `NONDETERMINISTIC_BUILD` | CI's double build produces byte-differing `extract/` or `dist/` trees.                                                                                                                                                                                                                                                                                |

---

## 6. WARN conditions (recorded, non-breaking)

### 6.1 Warning code registry

Nine codes. This registry is closed: emitting an unregistered code is a `SCHEMA_VIOLATION` against `quality-report.schema.json`.

| Code                          | Fires when                                                                                                                                                                                                                                                                                                                    | `subject`                                      | `impact`                                    | Config                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------- |
| `UNMAPPED_SHARE_HIGH`         | `mapped_instance_share < mapped_instance_share.warn_below`. Exactly one entry per build.                                                                                                                                                                                                                                      | absent (dataset-wide)                          | the actual `mapped_instance_share`          | `mapped_instance_share.warn_below`                                        |
| `UNMAPPED_DEVICE_HIGH_IMPACT` | An unmapped key meets **both** `issue_generator.min_instance_count` and `issue_generator.min_machine_count`. One entry per qualifying key.                                                                                                                                                                                    | `unknown:<key>`                                | `instance_count`                            | `issue_generator.min_instance_count`, `issue_generator.min_machine_count` |
| `MISSING_METADATA`            | A curated chip is missing any field listed in `chip_required_metadata`. One entry per chip; the message names every missing field, in sorted order. Stubs are exempt (they are counted as `chips_stub`, and warning on each would drown the array).                                                                           | chip id                                        | number of missing fields                    | `chip_required_metadata`                                                  |
| `UNVERIFIED_LICENSE`          | An implementation has no `license` field. Omission is mandated when the license is unverified (data-model.md §5.2), so this warning is the visible cost of that honesty, not a reason to guess.                                                                                                                               | implementation id                              | absent                                      | —                                                                         |
| `UNVERIFIED_ACCURACY`         | An implementation has no `accuracy` field.                                                                                                                                                                                                                                                                                    | implementation id                              | absent                                      | —                                                                         |
| `ZERO_MAPPED_CHIPS`           | A machine's post-overlay BOM has no row with a curated (non-`unknown:`) `chip_id` — including an empty BOM. Such a machine renders as a page with nothing on it and is excluded from Prospector consideration.                                                                                                                | machine id                                     | total BOM row count (0 when empty)          | —                                                                         |
| `STALE_REVIEW`                | An implementation has a `last_reviewed` older than `stale_review_days` before `manifest.build_date`. Implementations **without** `last_reviewed` are not stale — they are incomplete, and `completeness_percent.implementation` already reports that. Uses `build_date`, never wall-clock, so the report stays deterministic. | implementation id                              | age in whole days                           | `stale_review_days`                                                       |
| `STALE_REFERENCE`             | A curated file references an id that resolved through `aliases.json` (data-model.md §3.3). One entry per referencing file per alias used.                                                                                                                                                                                     | the repo-relative path of the referencing file | absent                                      | —                                                                         |
| `WARNINGS_TRUNCATED`          | Emitted warnings for some code were capped at `warning_cap_per_code`. One entry per truncated code.                                                                                                                                                                                                                           | absent                                         | the true pre-truncation count for that code | `warning_cap_per_code`                                                    |

### 6.2 Determinism of warnings

Warning generation MUST be a pure function of the build inputs. Messages MUST NOT embed anything order-dependent, path-of-the-build-machine-dependent, or time-dependent other than values derived from `manifest.build_date`. Warnings are collected, sorted by (`code`, `subject`, `message`), then truncated (§6.3) — sort _before_ truncate, so the retained set is stable.

### 6.3 Volume cap

For each code, at most `warning_cap_per_code` entries are retained (the first N after sorting). When a code is truncated, exactly one `WARNINGS_TRUNCATED` entry is appended carrying the true count in `impact`, and `summary.warnings_by_code` reports the retained count.

The cap exists because this report is a site-data chunk under the 250 KB gzip budget, and early in the project's life `MISSING_METADATA` and `ZERO_MAPPED_CHIPS` will each have thousands of legitimate subjects. Truncating deterministically is better than either failing the build or shipping an unbounded file.

---

## 7. Top unmapped devices by impact

`unmapped_devices` is the contributor's to-do list, and its array order **is** the impact ranking. There is no separate score field.

**Impact = `instance_count`**, ties broken by `key` ascending. That is the sort order data-model.md §8.3 already fixes for this array, so ranking and serialization are the same operation.

Why `instance_count` alone, and not a composite score:

- It is already machine-count-weighted by construction (§4.1) — a device in 500 machines outranks one in 5 without any extra term.
- Every candidate weighting term is either unavailable at this stage or misleading. Weighting by `coin_slots`, `driver_status`, or "interestingness" would encode taste into the one number contributors are asked to trust, and would make the ranking un-reproducible by hand.
- A contributor can verify their position in the list with arithmetic. A composite score they cannot re-derive is a score they will not trust.
- Prospector ranking (T6.3) is where weighting belongs — it is advisory and explicitly configurable. This list is factual.

**Consumption by T8.4**: take the first `issue_generator.top_n` entries that satisfy both `issue_generator.min_instance_count` and `issue_generator.min_machine_count`, dedupe against open issues by `key`, and open one issue each. Every such entry also carries a matching `UNMAPPED_DEVICE_HIGH_IMPACT` warning (§6.1) — the same eligibility predicate, one canonical pair of thresholds — so the issue generator can be driven from either array and get the same answer.

`sample_machines` is what makes an auto-generated issue researchable: it gives the contributor real boards to look up. It carries dist-side machine ids so the issue can link directly to `/machine/<slug>`.

---

## 8. Per-machine coverage confidence

`machine.coverage.confidence` (data-model.md §5.4.3) is derived per machine; the report rolls it up into `summary.coverage_confidence_counts`.

Let `rows` = post-overlay BOM row count (summing `count`, so a `count: 2` row is 2 rows), and `unknown_rows` = the same sum restricted to rows whose `chip_id` starts with `unknown:`. Let `u = unknown_rows / rows` (define `u = 1` when `rows = 0`).

Evaluated in order, first match wins:

1. **`low`** — `rows < coverage_confidence.min_bom_rows_for_high`, **or** `u > coverage_confidence.unknown_share_max_for_medium`. A three-part BOM is an abstraction, not a board; a BOM that is mostly unknown silicon cannot support any coverage claim.
2. **`medium`** — `u > 0` (any unknown row at all — this is data-model.md §5.4.3's hard requirement that confidence be ≤ medium whenever an `unknown:` row is present), **or** `mame_driver_status` is `preliminary` (MAME itself is telling us the hardware description is provisional).
3. **`high`** — otherwise.

`custom:` machines (overlay-created, fully hand-curated) are evaluated by the same rules; they have no `mame_driver_status`, so in practice they reach `high` whenever they have enough rows and no unknowns.

Confidence is deliberately about the _BOM's trustworthiness_, not the coverage percentage. A machine can be 0% implemented with `high` confidence — that is exactly the Prospector's most valuable signal: we are certain about what is missing.

---

## 9. Thresholds

All values live in `pipeline/config/quality-thresholds.json`. They are **starting points chosen from first principles and small samples, not measurements** — no full dataset existed when they were set. T9.1 (end-to-end data quality audit) is the scheduled point at which each is re-derived against the real distribution; a threshold that never fires and a threshold that fires on everything are equally useless, and the audit's job is to say which is which.

| Config key                                         | Value                             | Rationale                                                                                                                                                                                                                                       |
| -------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chip_required_metadata`                           | `["description", "manufacturer"]` | PLAN §3.8 names function and manufacturer as key metadata; `function` is schema-required so it can never be missing, and `description` is what makes a chip page readable, so it takes the vacated slot.                                        |
| `completeness_fields.chip`                         | 8 fields                          | §3.2 — every optional field on the curated chip record; the full set is the honest denominator for "how documented is this chip".                                                                                                               |
| `completeness_fields.core`                         | 4 fields                          | §3.2 — the four fields that make a core record actionable (who, where, what it runs, what family).                                                                                                                                              |
| `completeness_fields.device_map`                   | `["note"]`                        | §3.2 — the single field that distinguishes a justified mapping from an assertion.                                                                                                                                                               |
| `completeness_fields.implementation`               | 8 fields                          | §3.2 — all optional fields; `license` and `accuracy` also drive their own warnings, so they are double-counted deliberately (they matter twice).                                                                                                |
| `completeness_fields.machine`                      | 4 fields                          | §3.2 — machines are generated, so these four are precisely the fields curation adds on top of MAME.                                                                                                                                             |
| `completeness_fields.platform_family`              | 3 fields                          | §3.2 — `name` is required; these three are what turns a family key into a page worth visiting.                                                                                                                                                  |
| `coverage_confidence.min_bom_rows_for_high`        | `3`                               | Below three parts, the record is a MAME abstraction (one SoC device standing in for a board), not a bill of materials. Two is defensible for a trivially simple board; three errs toward not overclaiming.                                      |
| `coverage_confidence.unknown_share_max_for_medium` | `0.25`                            | Above a quarter unknown, a coverage percentage computed on the known remainder describes a minority of the board and would mislead. Chosen as a round quarter, not measured — a prime T9.1 candidate.                                           |
| `issue_generator.min_instance_count`               | `50`                              | A device below ~50 instances is a long-tail entry a curator will reach by working the worklist; an auto-opened GitHub issue for it costs more attention than it saves.                                                                          |
| `issue_generator.min_machine_count`                | `5`                               | Guards against a single machine with 60 instances of one custom device generating a "high impact" issue that helps exactly one board. Impact must be broad _and_ deep.                                                                          |
| `issue_generator.top_n`                            | `25`                              | One screen of open issues. Matches the Prospector's top-25 framing (TASKS T6.3) and keeps the "good first mapping" label from becoming a wall of noise contributors scroll past.                                                                |
| `mapped_instance_share.target`                     | `0.9`                             | The "healthy" band boundary for the dashboard (T6.5 stats chunk) — lives here so no color threshold gets hardcoded in the site. 90% leaves room for genuinely unidentifiable custom silicon, which will never be fully mapped.                  |
| `mapped_instance_share.warn_below`                 | `0.7`                             | Matches TASKS T3.1's shipping gate (≥ 70% mapped-or-ignored). Below this the dataset's board pages are more guess than fact, and the project should say so loudly on its own health page.                                                       |
| `stale_review_days`                                | `365`                             | HDL implementation repos change on a scale of years, not weeks; an annual re-check is enough to catch a license change or a rewrite without generating churn.                                                                                   |
| `version`                                          | `"1.0.0"`                         | Semver of this threshold set. Bumped whenever a value changes, so a report can be traced to the policy that produced it. Not a threshold; recorded for provenance.                                                                              |
| `warning_cap_per_code`                             | `500`                             | §6.3. 500 entries × ~150 bytes ≈ 75 KB per code before gzip; with nine codes the report stays comfortably inside the 250 KB gzip budget even in the worst case, while still giving a contributor far more work than they can do in one sitting. |

Every key above exists in the config file, and every key in the config file appears above. Adding a threshold means editing both.

---

## 10. Implementation notes for T6.4

- Load `pipeline/config/quality-thresholds.json` once at startup; treat it as data. Any numeric literal in the quality code that is not `0`, `1`, or a rounding constant from data-model.md §8.4 is a bug.
- Compute the instance accounting (§4.2) during the device-map resolution pass, not afterward — the resolution targets are already in hand there, and a second pass over 40k machines would be pure waste.
- Validate the finished report against `quality-report.schema.json` before writing it. A malformed health report is a `SCHEMA_VIOLATION` like any other file.
- Assert `chip_instances_total == mapped + ignored + unknown` and `distinct_devices_total == mapped + ignored + unknown` before emitting; a mismatch means the enumeration double-counted and MUST fail the build rather than publish a wrong headline number.
- The report contains no timestamps and no wall-clock-derived values. `STALE_REVIEW` ages are computed against `manifest.build_date` so a rebuild of an old commit reproduces the old report byte-for-byte.
