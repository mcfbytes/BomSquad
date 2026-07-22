# BOM Squad Data Model

**Spec version 1.0.0 · Normative**

This document is the canonical specification of BOM Squad's entities, identifiers, storage layout, overlay semantics, and serialization rules. The JSON Schemas in `schemas/` are implemented _from_ this document; where they disagree, this document wins and the schema is buggy.

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, MAY, and OPTIONAL are to be interpreted as described in RFC 2119.

JSON examples in this spec are **normative for shape and canonical form** (field presence, types, key order). Domain values inside examples (clocks, years) illustrate mechanics only and are not asserted as hardware facts.

Delegated sections: the `function` taxonomy value set is owned by `docs/taxonomy.md` (T1.3); equivalence/`provides` _semantics_ and coverage math by the equivalence spec (T1.4); quality warning-code definitions and thresholds by the quality spec (T1.7). Each of those operates strictly inside the envelopes fixed here and MUST NOT alter field names, types, or envelope structure defined in this document.

---

## 1. Identifiers

### 1.1 Grammars

All identifiers are ASCII, lowercase, and case-sensitive (there is no case folding anywhere in the system).

| Name               | Regex                                                               | Used by                                                |
| ------------------ | ------------------------------------------------------------------- | ------------------------------------------------------ |
| **bare slug**      | `^[a-z0-9]+(?:-[a-z0-9]+)*$` (1–64 chars)                           | chip id, implementation id, platform-family id         |
| **MAME shortname** | `^[a-z0-9_]{1,64}$`                                                 | payload of `mame:` and `unknown:` ids; device-map keys |
| **chip id**        | `^[a-z0-9]+(?:-[a-z0-9]+)*$`                                        | curated chips                                          |
| **chip ref**       | chip id **or** `^unknown:[a-z0-9_]{1,64}$`                          | `chip_id` fields in BOMs                               |
| **machine id**     | `^mame:[a-z0-9_]{1,64}$` **or** `^custom:[a-z0-9]+(?:-[a-z0-9]+)+$` | machines                                               |
| **core id**        | `^core:[a-z0-9]+(?:-[a-z0-9]+)*$`                                   | cores                                                  |
| **family id**      | bare slug                                                           | platform families                                      |

Additional constraints:

- A bare slug MUST NOT contain a colon (`:`). The grammar already guarantees this; implementations MUST treat any colon in a bare-slug position as a validation failure, not as an implicit namespace.
- A full id (including any prefix) MUST NOT exceed 80 characters.
- The words `mame`, `unknown`, `core`, and `custom` are **reserved** and MUST NOT be used as a complete bare id (e.g. a chip id of exactly `unknown` is invalid). They MAY appear as segments of longer slugs (`core-logic` is fine).
- A `custom:` machine slug MUST contain at least two hyphen-separated segments (at least one `-`). This makes the machine route inverse total (§2.3): MAME shortnames can never contain `-`, custom slugs always do.
- A core id MUST begin, after the `core:` prefix, with the record's `platform` value followed by a hyphen (e.g. `platform: "mister"` ⇒ id matches `^core:mister-`).

### 1.2 Reserved namespace prefixes

The namespace prefixes `mame:`, `unknown:`, `core:`, and `custom:` are reserved. Consumers MUST fail closed: an id containing a colon whose prefix is not one of these four is a validation error, never a passthrough. New namespaces require a version bump of this spec.

| Prefix     | Meaning                                                                                 | Minted by       |
| ---------- | --------------------------------------------------------------------------------------- | --------------- |
| `mame:`    | machine extracted from MAME; payload is the MAME shortname verbatim                     | pipeline (T6.1) |
| `unknown:` | chip stub for an unmapped MAME device; payload is the device lookup key (§6.2) verbatim | pipeline (T6.1) |
| `core:`    | FPGA core                                                                               | curator         |
| `custom:`  | machine that does not exist in MAME, created by an overlay (§7.6)                       | curator         |

---

## 2. Route slugs (URLs)

### 2.1 Route spaces

Every entity type owns one route space: `/chip/`, `/machine/`, `/core/`, `/family/`, `/implementation/`.

### 2.2 Derivation (id → path)

`route(id)`:

| Entity         | Rule                                    | Example                                                                  |
| -------------- | --------------------------------------- | ------------------------------------------------------------------------ |
| chip (bare)    | `/chip/` + id                           | `ym2151` → `/chip/ym2151`                                                |
| chip (unknown) | `/chip/` + **full id including prefix** | `unknown:sega_315_5197` → `/chip/unknown:sega_315_5197`                  |
| machine        | `/machine/` + payload after the prefix  | `mame:outrun` → `/machine/outrun`; `custom:foo-bar` → `/machine/foo-bar` |
| core           | `/core/` + payload after `core:`        | `core:mister-arcade-outrun` → `/core/mister-arcade-outrun`               |
| family         | `/family/` + id                         | `sega-outrun-hw` → `/family/sega-outrun-hw`                              |
| implementation | `/implementation/` + id                 | `jt51` → `/implementation/jt51`                                          |

`unknown:` chips do **not** strip their prefix. Rationale: bare chip ids and `unknown:` payloads share the `/chip/` route space and could otherwise collide (`unknown:z80x` vs a future chip `z80x`); a colon can never appear in a bare slug, so keeping the prefix makes collision structurally impossible. The colon is a legal path character (RFC 3986 `pchar`); emitters MUST write it literally, and parsers MUST accept both the literal form and `%3A`.

### 2.3 Inverse (path → id)

The inverse MUST be total and computable without data lookups:

- `/chip/<s>`: if `<s>` contains `:`, it MUST parse as `unknown:<shortname>`, and the id is `<s>` verbatim; otherwise the id is the bare slug `<s>`.
- `/machine/<s>`: if `<s>` contains `-`, the id is `custom:<s>`; otherwise the id is `mame:<s>`. (Sound because MAME shortnames never contain `-` and custom slugs always do — §1.1.)
- `/core/<s>` → `core:<s>`. `/family/<s>` → `<s>`. `/implementation/<s>` → `<s>`.

A path whose slug fails the target grammar is a 404, not an error page.

### 2.4 Collisions

Within each route space, the set of route slugs derived from **all live ids plus all alias keys** (§3) MUST be unique. The site-data emitter MUST verify this and any duplicate is a **build failure** (`ROUTE_COLLISION`). By grammar this can only arise for `/machine/` (`mame:` vs `custom:` payloads without `-` — already excluded by §1.1) — the check is retained as defense in depth and to protect future namespaces.

---

## 3. ID stability and aliases

### 3.1 Stability guarantee

An id that has shipped in any published dataset is **permanent**. It MUST NOT be renamed, re-pointed to a different real-world subject, or reused for a different entity. Fixing a bad slug means minting a new id and recording an alias from the old one.

### 3.2 The alias mechanism: one central file

Aliases live in **one central curated file**, `data/mappings/aliases.json` — not as fields on entity records. Rationale: machines are generated, so a per-record alias field cannot survive re-extraction without abusing overlays, whereas a central file covers every entity type uniformly (including `mame:` renames when MAME itself renames a shortname). It also makes the collision check and the site's redirect map a single-input, single-pass operation.

File shape (`schemas/aliases.schema.json`):

```json
{
  "aliases": {
    "mame:puckmanb": "mame:puckman",
    "ym-2151": "ym2151"
  }
}
```

- Each key is a retired id; each value is the current id. Both MUST satisfy the id grammar of the same entity type (chip↔chip, machine↔machine, core↔core, family↔family, implementation↔implementation; the type is inferred from the id shape and MUST match on both sides — for prefix-less ids, chip / family / implementation aliasing is distinguished by which live entity the value resolves to).
- The value MUST resolve to a **live** entity in the built dataset (`DANGLING_REFERENCE` failure otherwise).
- A key MUST NOT equal any live id (`ALIAS_COLLISION` failure). This also guarantees route-level uniqueness via §2.4.
- **No chains:** a value MUST NOT itself appear as a key. When an entity is renamed a second time, every alias pointing at it MUST be re-pointed to the newest id in the same change. Resolution is therefore always a single hop.
- An alias, once shipped, is itself permanent: entries MUST NOT be removed (removing one breaks old URLs).
- `unknown:` ids MUST NOT appear on either side (they are ephemeral stubs, §6).

### 3.3 Build-time resolution

Wherever a curated input references an id — overlay `target`, `core.machines[]`, family `machines[]`, `implementation.chip_ids[]`, equivalence chip refs, device-map `chip_id` values, overlay-supplied `known_consumers` values — the pipeline MUST resolve through `aliases.json` (single hop) **before** any other processing, and MUST emit a `STALE_REFERENCE` **warning** naming the file and the alias used. Warning, not failure: aliases exist precisely so that existing references keep working; curators clean them up at leisure. Published `dist/` output MUST contain only canonical ids — never alias keys — except inside the `aliases.json` chunk itself.

### 3.4 Site redirects

The build publishes the alias map as the site-data chunk with logical name `aliases.json`. The SPA route resolver, on failing to match a route slug against live data, MUST look up the corresponding id in the alias map and, on a hit, navigate to the canonical route with history replacement (`replaceUrl`) and render a `<link rel="canonical">` pointing at the canonical route. This is the project's 301-equivalent: permanent by contract because aliases are never deleted. (A static host cannot emit true per-entity 301s for an SPA; this is the deliberate substitute.)

---

## 4. Storage layout and the generated/curated boundary

### 4.1 Authorship table

| Path                             | Writer        | Mechanism                                                                                  | Hand edits |
| -------------------------------- | ------------- | ------------------------------------------------------------------------------------------ | ---------- |
| `schemas/`                       | human         | PR                                                                                         | yes        |
| `data/chips/`                    | human         | PR (one file per chip, `<id>.json`)                                                        | yes        |
| `data/implementations/`          | human         | PR (one file per implementation, `<id>.json`)                                              | yes        |
| `data/cores/`                    | human         | PR (one file per core, `<route-slug>.json`, e.g. `mister-arcade-outrun.json`)              | yes        |
| `data/mappings/`                 | human         | PR (`mame-device-map.json`, `platform-families.json`, `equivalences.json`, `aliases.json`) | yes        |
| `data/overlays/machines/`        | human         | PR (§7)                                                                                    | yes        |
| `data/overlays/implementations/` | human         | PR (§7.7)                                                                                  | yes        |
| `extract/`                       | pipeline only | `pipeline extract`; committed via automated or reviewed PR for diff-ability                | **never**  |
| `dist/`                          | pipeline only | `pipeline build`; never committed (released as artifacts)                                  | **never**  |
| `pipeline/`, `site/`, `docs/`    | human         | PR (code and prose)                                                                        | yes        |

Scripts (discovery, seeding) MAY _propose_ curated content, but only by writing candidate files under `extract/` for human review or by opening PRs against `data/`; nothing lands in `data/` without human review.

### 4.2 The correction rule

A correction to generated data MUST be expressed as curated input — a device-map entry, a mapping change, an alias, or an overlay — never as an edit to `extract/` or `dist/`. Re-running extraction MUST NOT lose any curation.

### 4.3 Filenames

- Per-entity curated files: filename stem MUST equal the record's id (chips, implementations) or its route slug (cores, machine overlays). Mismatch is a validation failure.
- Keyed-collection files (`mame-device-map.json`, `platform-families.json`, `aliases.json`, `equivalences.json`) carry ids as object keys; entries MUST NOT repeat the id inside the entry body.
- Every curated file MAY carry a top-level `"$schema"` string pointing at its schema (relative path); the pipeline MUST ignore it. Files are strict JSON — no comments, no trailing commas, no duplicate keys (the linter MUST reject duplicates).

---

## 5. Entities

Field tables use: **Req** = REQUIRED, Opt = OPTIONAL. "—" in _Format_ means free-form string. Optional means the key is **absent** when unknown — never `null` (rule 3: omit rather than guess; `null` is reserved by overlay semantics §7).

### 5.1 chip (curated: `data/chips/<id>.json`)

| Field              | Type     | Req | Format / values                                                              | Meaning                                                      |
| ------------------ | -------- | --- | ---------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `id`               | string   | Req | chip id (bare slug); = filename stem                                         | permanent identity                                           |
| `names`            | string[] | Req | minItems 1, unique; **order significant, first is the primary display name** | display names / well-known aliases (e.g. `["YM2151","OPM"]`) |
| `function`         | string   | Req | taxonomy value per `docs/taxonomy.md`; grammar `^[a-z]+(?:\.[a-z]+)?$`       | single classification (e.g. `cpu`, `sound.fm`)               |
| `manufacturer`     | string   | Opt | —                                                                            | e.g. `Yamaha`                                                |
| `model`            | string   | Opt | —                                                                            | manufacturer part number, e.g. `YM2151`                      |
| `family`           | string   | Opt | —                                                                            | free-text family grouping, e.g. `OPM`                        |
| `description`      | string   | Opt | one sentence                                                                 | what the chip is                                             |
| `typical_clock_hz` | integer  | Opt | > 0                                                                          | typical operating clock                                      |
| `package`          | string   | Opt | —                                                                            | e.g. `DIP-24`                                                |
| `year_introduced`  | integer  | Opt | 1950–2030                                                                    | first commercial year                                        |
| `datasheet_urls`   | string[] | Opt | URIs, sorted, unique                                                         | datasheet / doc links                                        |
| `notes`            | string   | Opt | —                                                                            | free text; MUST carry source citations for non-obvious facts |

**`mame_devices` is deliberately absent from curated chips and MUST NOT appear there.** The MAME-device → chip join has exactly one curated home: `data/mappings/mame-device-map.json` (§5.6). Rationale: a single source of truth removes dual-maintenance drift, and the map is also the only possible home for `ignore` entries — splitting the join across chip files would fragment it. (This refines PLAN §3.1, whose example shows `mame_devices` illustratively.) The _normalized_ chip (§5.1.1) carries a derived `mame_devices`.

The value `unknown` for `function` is reserved for pipeline-minted stubs (§6.4) and MUST NOT appear in curated chip files.

Normative example (`data/chips/ym2151.json`):

```json
{
  "id": "ym2151",
  "description": "8-channel, 4-operator FM sound synthesis chip",
  "family": "OPM",
  "function": "sound.fm",
  "manufacturer": "Yamaha",
  "model": "YM2151",
  "names": ["YM2151", "OPM"],
  "package": "DIP-24",
  "typical_clock_hz": 3579545,
  "year_introduced": 1984
}
```

#### 5.1.1 chip (normalized, dist only)

The normalized chip is the curated record plus derived fields:

| Field          | Type     | Req | Meaning                                                                             |
| -------------- | -------- | --- | ----------------------------------------------------------------------------------- |
| `mame_devices` | string[] | Opt | device lookup keys mapped to this chip, derived by inverting the device map; sorted |
| `stub`         | boolean  | Opt | present (and `true`) only on `unknown:` stubs (§6.4)                                |

Reverse indexes (machines using the chip, implementations of it) are presentation data assembled per chunk by the emitter (T6.5), not entity fields.

### 5.2 implementation (curated: `data/implementations/<id>.json`)

| Field                       | Type     | Req | Format / values                                                                              | Meaning                                                                                                                                                                 |
| --------------------------- | -------- | --- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                        | string   | Req | bare slug; = filename stem                                                                   | permanent identity                                                                                                                                                      |
| `name`                      | string   | Req | —                                                                                            | display name, e.g. `JT51`                                                                                                                                               |
| `chip_ids`                  | string[] | Req | minItems 1; curated chip ids (no `unknown:`); sorted, unique                                 | chips this HDL implements. Plural by design: one IP may cover several canonical chips (PLAN §8 granularity mitigation). Supersedes the singular `chip_id` of PLAN §3.2. |
| `repo`                      | string   | Req | URI                                                                                          | source repository                                                                                                                                                       |
| `language`                  | string   | Req | `mixed` \| `other` \| `systemverilog` \| `verilog` \| `vhdl`                                 | HDL language                                                                                                                                                            |
| `paths`                     | string[] | Opt | repo-relative; **order significant, first entry is the top-level module**                    | where the HDL lives                                                                                                                                                     |
| `license`                   | string   | Opt | SPDX license expression, or the literal `custom` (details in `notes`)                        | verified from the repo's LICENSE — never guessed; omit when unverified (quality warns)                                                                                  |
| `author`                    | string   | Opt | —                                                                                            | principal author                                                                                                                                                        |
| `accuracy`                  | string   | Opt | `behavioral` \| `cycle-accurate` \| `cycle-approximate` \| `gate-level` \| `partial`         | omit when unassessed (quality warns)                                                                                                                                    |
| `verified_against_hardware` | boolean  | Opt | `true` REQUIRES a citation in `notes`; `false` = assessed and not verified; absent = unknown | hardware verification status                                                                                                                                            |
| `target_platforms`          | string[] | Opt | values from platform enum (§5.5) plus `generic`; sorted, unique                              | platforms it is known to build for                                                                                                                                      |
| `resource_notes`            | string   | Opt | —                                                                                            | e.g. `≈3k LEs on Cyclone V`                                                                                                                                             |
| `last_reviewed`             | string   | Opt | `YYYY-MM-DD`                                                                                 | last curator review date                                                                                                                                                |
| `notes`                     | string   | Opt | —                                                                                            | free text, citations                                                                                                                                                    |

**`known_consumers` MUST NOT appear in curated implementation files.** It is derived at build time (T4.5) from core/discovery data, with curated additions or removals expressed as implementation overlays (§7.7). The normalized implementation carries `known_consumers`: sorted, unique core ids.

Normative example:

```json
{
  "id": "jt51",
  "accuracy": "cycle-approximate",
  "author": "Jose Tejada (jotego)",
  "chip_ids": ["ym2151"],
  "language": "verilog",
  "last_reviewed": "2026-07-01",
  "license": "GPL-3.0-only",
  "name": "JT51",
  "notes": "De-facto standard OPM implementation. Hardware verification: see repo README test reports.",
  "paths": ["hdl/jt51.v"],
  "repo": "https://github.com/jotego/jt51",
  "target_platforms": ["generic", "mist", "mister", "pocket"],
  "verified_against_hardware": true
}
```

### 5.3 machine — raw (generated: `extract/machines.raw.json`)

One file, an envelope:

| Field          | Type         | Req | Meaning                                                                                 |
| -------------- | ------------ | --- | --------------------------------------------------------------------------------------- |
| `mame_version` | string       | Req | e.g. `0.288`, from the input XML                                                        |
| `filter`       | object       | Opt | verbatim copy of the applied filter configuration (shape owned by T2.3's config schema) |
| `machines`     | RawMachine[] | Req | sorted by `mame_name`                                                                   |

`RawMachine` — MAME vocabulary only; **no BOM Squad ids are minted at this stage** (the normalizer is the single place ids are minted):

| Field           | Type      | Req | Format / values                                                | Meaning                           |
| --------------- | --------- | --- | -------------------------------------------------------------- | --------------------------------- |
| `mame_name`     | string    | Req | MAME shortname                                                 | machine key within MAME           |
| `description`   | string    | Req | verbatim from XML                                              | MAME display name                 |
| `sourcefile`    | string    | Req | e.g. `sega/outrun.cpp`                                         | driver source file                |
| `year`          | string    | Opt | verbatim (`"1986"`, `"19??"`) — raw keeps MAME's string form   | claimed year                      |
| `manufacturer`  | string    | Opt | verbatim                                                       | claimed manufacturer              |
| `cloneof`       | string    | Opt | MAME shortname                                                 | parent machine                    |
| `romof`         | string    | Opt | MAME shortname                                                 | ROM parent                        |
| `is_bios`       | boolean   | Req |                                                                | `isbios` attr                     |
| `is_device`     | boolean   | Req |                                                                | `isdevice` attr                   |
| `is_mechanical` | boolean   | Req |                                                                | `ismechanical` attr               |
| `runnable`      | boolean   | Req |                                                                | `runnable` attr                   |
| `driver_status` | string    | Opt | `good` \| `imperfect` \| `preliminary`                         | `<driver status>`                 |
| `coin_slots`    | integer   | Opt | ≥ 1; from `<input coins>`; absent when the attr is absent or 0 | drives `kind` derivation (§5.4.1) |
| `clone_count`   | integer   | Opt | ≥ 1; present iff clones were dropped by the filter             | clones folded into this parent    |
| `chips`         | RawChip[] | Req | **document order** (may be empty)                              | `<chip>` elements                 |
| `device_refs`   | string[]  | Req | **document order, duplicates preserved** (may be empty)        | `<device_ref name>` values        |

`RawChip`:

| Field      | Type    | Req | Meaning                                         |
| ---------- | ------- | --- | ----------------------------------------------- |
| `type`     | string  | Req | `audio` \| `cpu` — MAME's `type` attr           |
| `tag`      | string  | Req | MAME tag, e.g. `maincpu` (leading `:` stripped) |
| `name`     | string  | Req | MAME display name attr, verbatim, e.g. `M68000` |
| `clock_hz` | integer | Opt | > 0; from `clock` attr when present and > 0     |

The committed file is the **post-filter** output (T2.3); the schema nevertheless describes the full shape so filter-config changes never require a schema change.

### 5.4 machine — normalized (dist only; produced by T6.1)

| Field                | Type       | Req | Format / values                                                           | Meaning                                                                                |
| -------------------- | ---------- | --- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `id`                 | string     | Req | machine id (`mame:` or `custom:`)                                         | identity                                                                               |
| `name`               | string     | Req | —                                                                         | display name (raw `description`, overlay-correctable)                                  |
| `kind`               | string     | Req | `arcade` \| `computer` \| `console` \| `handheld` \| `other` \| `unknown` | machine class (derivation §5.4.1)                                                      |
| `source`             | object     | Req | §5.4.2                                                                    | provenance                                                                             |
| `chips`              | BomEntry[] | Req | sorted by (`role`, `chip_id`); may be empty                               | the BOM (assembly §6.5)                                                                |
| `manufacturer`       | string     | Opt | —                                                                         | from raw / overlay                                                                     |
| `year`               | integer    | Opt | 1900–2100                                                                 | parsed from raw `year` **only when it is a plain 4-digit number**; otherwise omitted   |
| `platform_family`    | string     | Opt | family id                                                                 | from `platform-families.json` **only** — never settable by overlay (one home per fact) |
| `cloneof`            | string     | Opt | machine id                                                                | present only if the filter admits clones                                               |
| `clone_count`        | integer    | Opt | ≥ 1                                                                       | from raw                                                                               |
| `mame_driver_status` | string     | Opt | `good` \| `imperfect` \| `preliminary`                                    | raw passthrough                                                                        |
| `notes`              | string     | Opt | —                                                                         | overlay-supplied commentary (e.g. discrete-logic notes)                                |
| `coverage`           | object     | Opt | §5.4.3                                                                    | derived by T6.2                                                                        |
| `cores`              | string[]   | Opt | core ids, sorted, unique                                                  | derived reverse index                                                                  |

`BomEntry`:

| Field      | Type    | Req | Format / values                                                                                                                                                                   | Meaning                                                                          |
| ---------- | ------- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `chip_id`  | string  | Req | chip ref (bare or `unknown:`)                                                                                                                                                     | what the part is                                                                 |
| `role`     | string  | Req | verbatim MAME tag for `<chip>`-derived rows; the literal `device` for `device_ref`-derived rows; curator-chosen tag-grammar string (`^[a-z0-9_.:]{1,64}$`) for overlay-added rows | position on the board                                                            |
| `origin`   | string  | Req | `mame` \| `overlay`                                                                                                                                                               | who introduced the row (`mame` even when a field was later corrected by overlay) |
| `clock_hz` | integer | Opt | > 0                                                                                                                                                                               | clock                                                                            |
| `count`    | integer | Opt | ≥ 2; **omitted when 1** (canonical form)                                                                                                                                          | identical instances collapsed into this row                                      |
| `note`     | string  | Opt | —                                                                                                                                                                                 | per-row commentary (overlay-supplied)                                            |

**(`role`, `chip_id`) is the identity key of a BOM row** and MUST be unique within a machine (§6.5 guarantees it; violation is a build failure). To "change" a key field, an overlay removes the old row and adds a new one (§7.4).

#### 5.4.1 `kind` derivation

Precedence, first match wins: (1) overlay-set `kind`; (2) the machine's platform family `kind` (§5.8); (3) `arcade` if raw `coin_slots` ≥ 1; (4) `unknown`. MAME's XML has no machine-class field; this rule is honest about that — consoles/computers/handhelds reach their true kind via family or overlay curation, and `unknown` is the visible backlog.

#### 5.4.2 `source`

For `mame:` machines: `{ "driver": "<sourcefile>", "mame_version": "<version>", "type": "mame" }`.
For `custom:` machines: `{ "overlay": "<path relative to data/overlays/>", "type": "overlay" }`.
`source` is immutable: overlays MUST NOT touch it.

#### 5.4.3 `coverage` (envelope fixed here; math owned by T1.4/T6.2)

```json
{
  "confidence": "high",
  "implemented": 9,
  "mapped_total": 11,
  "missing": [{ "chip_id": "unknown:sega_315_5197", "reason": "unmapped-device" }],
  "percent": 81.8
}
```

`confidence` ∈ `high` | `medium` | `low` (MUST be ≤ `medium` when any `unknown:` row is present). `missing[].reason` ∈ `no-implementation` | `unknown-chip` | `unmapped-device`. `missing` sorted by (`chip_id`). `percent` per §8.4. The equivalence spec (T1.4) governs how `implemented` counts through equivalence and `provides` edges; it MUST NOT change this envelope.

### 5.5 core (curated: `data/cores/<route-slug>.json`)

Platform enum (shared with §5.2): `mist` | `mister` | `neptuno` | `other` | `pocket` | `replay`. (`generic` is legal only in `implementation.target_platforms`.)

| Field               | Type     | Req               | Format / values                                                | Meaning                                                              |
| ------------------- | -------- | ----------------- | -------------------------------------------------------------- | -------------------------------------------------------------------- |
| `id`                | string   | Req               | core id; §1.1 platform-prefix rule; route slug = filename stem | identity                                                             |
| `name`              | string   | Req               | —                                                              | display name                                                         |
| `platform`          | string   | Req               | platform enum                                                  | target FPGA platform                                                 |
| `open_source`       | boolean  | Req               |                                                                | HDL sources public (`false` for rbf-only / closed; basis in `notes`) |
| `machines`          | string[] | Req               | machine ids; sorted, unique; MAY be empty                      | machines this core implements                                        |
| `unmapped_reason`   | string   | conditionally Req | REQUIRED iff `machines` is empty, else MUST be absent          | why no machine mapping exists                                        |
| `repo`              | string   | Opt               | URI                                                            | repository                                                           |
| `author`            | string   | Opt               | —                                                              | principal author                                                     |
| `platform_families` | string[] | Opt               | family ids; sorted, unique                                     | curated family claims (e.g. console cores without machine lists)     |
| `notes`             | string   | Opt               | —                                                              | free text                                                            |

Normalized core (dist): curated record plus `platform_families` replaced by the sorted union of curated values and the families of all mapped machines.

Normative example (`data/cores/mister-arcade-outrun.json`):

```json
{
  "id": "core:mister-arcade-outrun",
  "machines": ["mame:outrun", "mame:outruneh"],
  "name": "Arcade: Out Run",
  "open_source": true,
  "platform": "mister",
  "repo": "https://github.com/MiSTer-devel/Arcade-OutRun_MiSTer"
}
```

### 5.6 device-map entry (curated: `data/mappings/mame-device-map.json`)

The **single source of truth** for the MAME-device → chip join.

```json
{
  "devices": {
    "m68000": { "chip_id": "m68000" },
    "screen": { "ignore": true, "reason": "MAME presentation abstraction, not board silicon" },
    "sega_315_5124": {
      "chip_id": "sega-vdp-315-5124",
      "note": "SMS/Mark III VDP; MAME shortname per src/devices/video/315_5124.cpp"
    }
  }
}
```

- Keys: device **lookup keys** (§6.2), grammar `^[a-z0-9_]{1,64}$`, sorted. The worklist (§5.7) emits exactly these keys, so curators map exactly what the pipeline looks up.
- Entry, exactly one of the two forms:
  - **map**: `chip_id` (Req, curated chip id — `unknown:` and aliases-of-nothing are invalid; alias keys resolve per §3.3) + `note` (Opt — SHOULD be present for every non-obvious mapping).
  - **ignore**: `ignore: true` (Req) + `reason` (Req, non-empty). Mandatory reason keeps the shrinking worklist honest.
- A `chip_id` value MUST resolve to an existing curated chip (`DANGLING_REFERENCE` failure).

### 5.7 device worklist (generated: `extract/mame-devices.raw.json`)

Envelope `{ "devices": [...], "mame_version": "0.288" }`. Entry:

| Field                  | Type     | Req | Meaning                                                                                                   |
| ---------------------- | -------- | --- | --------------------------------------------------------------------------------------------------------- |
| `key`                  | string   | Req | device lookup key (§6.2)                                                                                  |
| `display_names`        | string[] | Req | distinct raw `chips[].name` strings that normalized to this key; sorted; empty for pure `device_ref` keys |
| `chip_instances`       | integer  | Req | occurrences via `<chip>` elements across filtered machines                                                |
| `device_ref_instances` | integer  | Req | occurrences via `device_ref` (after §6.5 dedup)                                                           |
| `machine_count`        | integer  | Req | distinct machines referencing the key                                                                     |
| `sample_machines`      | string[] | Req | ≤ 5 `mame_name`s, sorted                                                                                  |

Array sorted by (`chip_instances` + `device_ref_instances`) descending, then `key` ascending — the curation priority order.

### 5.8 platform-family (curated: `data/mappings/platform-families.json`)

```json
{
  "families": {
    "sega-outrun-hw": {
      "drivers": ["sega/outrun.cpp"],
      "kind": "arcade",
      "manufacturer": "Sega",
      "name": "Sega Out Run Hardware"
    }
  }
}
```

Entry (key = family id, bare slug):

| Field          | Type     | Req | Meaning                                                                                            |
| -------------- | -------- | --- | -------------------------------------------------------------------------------------------------- |
| `name`         | string   | Req | display name                                                                                       |
| `machines`     | string[] | Opt | explicit member machine ids; sorted, unique                                                        |
| `drivers`      | string[] | Opt | MAME `sourcefile` values; every machine whose raw `sourcefile` matches is a member; sorted, unique |
| `kind`         | string   | Opt | machine-kind enum value inherited by members (§5.4.1)                                              |
| `manufacturer` | string   | Opt | —                                                                                                  |
| `description`  | string   | Opt | —                                                                                                  |
| `notes`        | string   | Opt | —                                                                                                  |

At least one of `machines` / `drivers` MUST be present. Membership resolution: explicit `machines` listing **overrides** driver-rule membership (so one oddball machine in a shared driver can belong elsewhere). After resolution every machine MUST belong to at most one family; two explicit claims, or two driver-rule claims from different families, are a **build failure** (`FAMILY_CONFLICT`). Every explicit machine id and every driver value MUST match at least one extracted machine (`DANGLING_REFERENCE`).

### 5.9 equivalence edges (curated: `data/mappings/equivalences.json`)

Structural contract (semantics and coverage math: T1.4 spec):

```json
{
  "classes": [
    {
      "chips": ["ym2612", "ym3438"],
      "note": "YM3438 is a CMOS die-shrink of YM2612; functionally interchangeable here"
    }
  ],
  "provides": [
    {
      "note": "68010 is socket/ISA compatible upward for 68000 software",
      "provider": "m68010",
      "provides": "m68000"
    }
  ]
}
```

- `classes[]`: `chips` (Req, ≥ 2 curated chip ids, sorted, unique) + `note` (Req). Classes MUST be pairwise disjoint (equivalence is transitive — merge instead of overlapping). Array sorted by `chips[0]`.
- `provides[]`: `provider` (Req), `provides` (Req), `note` (Req); `provider` ≠ `provides`; no duplicate (`provider`, `provides`) pairs; array sorted by (`provider`, `provides`). Directional: an implementation of `provider` can satisfy a `provides` socket, not vice versa.
- All chip refs MUST be curated chip ids — `unknown:` is forbidden.

### 5.10 overlay (curated: `data/overlays/…`) — shape

See §7 for merge semantics. File shape (`schemas/overlay-machine.schema.json`):

| Field         | Type     | Req | Meaning                                                                                               |
| ------------- | -------- | --- | ----------------------------------------------------------------------------------------------------- |
| `target`      | string   | Req | machine id (machine overlays) or implementation id (implementation overlays); alias-resolved per §3.3 |
| `reason`      | string   | Req | **why this overlay exists** — provenance is mandatory                                                 |
| `patch`       | object   | Req | the merge document (§7)                                                                               |
| `create`      | boolean  | Opt | `true` only when minting a `custom:` machine (§7.6); absent otherwise                                 |
| `source_urls` | string[] | Opt | citations backing the correction; sorted, unique                                                      |

Filename: `<route-slug-of-target>.json`, or `<route-slug-of-target>__<qualifier>.json` (qualifier `^[a-z0-9-]{1,32}$`) when multiple overlays target one entity. The stem before `__` MUST equal the target's route slug.

### 5.11 site-data manifest (generated: `dist/site-data/manifest.json`)

| Field             | Type   | Req | Meaning                                                                                                                                                                                                                |
| ----------------- | ------ | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema_version`  | string | Req | semver of the manifest contract (this spec: `1.0.0`)                                                                                                                                                                   |
| `dataset_version` | string | Req | `^\d{4}\.\d{2}\.\d{2}(?:\.\d+)?$` for releases; supplied as a build input by the release workflow; a build without one MUST use the constant `0.0.0-dev`                                                               |
| `mame_version`    | string | Req | pinned MAME release, e.g. `0.288`                                                                                                                                                                                      |
| `build_date`      | string | Req | ISO 8601 UTC `YYYY-MM-DDTHH:MM:SSZ`; MUST be derived from `SOURCE_DATE_EPOCH` if set, else the HEAD commit's committer timestamp, else `1970-01-01T00:00:00Z` — never wall-clock, so double-builds stay byte-identical |
| `counts`          | object | Req | integers: `chips` (curated), `chips_unknown` (stubs), `cores`, `families`, `implementations`, `machines`                                                                                                               |
| `chunks`          | object | Req | logical name → chunk descriptor, keys sorted                                                                                                                                                                           |

Chunk descriptor: `{ "bytes": <int>, "gzip_bytes": <int>, "path": "<hashed path>", "sha256": "<64 hex>" }` — all REQUIRED. `gzip_bytes` MUST be ≤ 256 000 (the 250 KB budget) for every chunk; violation fails the build.

Logical names (fixed): `aliases.json`, `stats.json`, `chips/index.json`, `chips/{id}.json` (id = chip route slug), `machines/index-{nn}.json` (`nn` = zero-padded decimal shard from `00`), `machines/detail/{xx}.json` (`xx` = first 2 hex chars of `sha256(utf8(machine id))`; file body = object keyed by machine id, keys sorted), `families/index.json`, `families/{id}.json`, `implementations/index.json`, `cores/index.json`, `prospector/{platform}.json`, `search/{n}.json`, `quality-report.json`.

Physical path of a chunk: `<logical-dir>/<logical-stem>.<first 12 hex of sha256 of the file bytes>.json`. Only `manifest.json` itself is unhashed. The payload shapes of `stats.json`, `prospector/*`, and `search/*` chunks are owned by T6.5/T6.3/T7.3 respectively; they MUST obey §8 and carry only data derived from build inputs. Index and detail chunks carry the normalized entities of §5 (indexes MAY project a field subset, defined by T6.5).

### 5.12 quality-report (generated: `dist/quality-report.json`, also published as a chunk)

| Field              | Type       | Req | Meaning                                                                                                                 |
| ------------------ | ---------- | --- | ----------------------------------------------------------------------------------------------------------------------- |
| `schema_version`   | string     | Req | semver of this envelope (`1.0.0`)                                                                                       |
| `dataset_version`  | string     | Req | as manifest                                                                                                             |
| `mame_version`     | string     | Req | as manifest                                                                                                             |
| `summary`          | object     | Req | REQUIRED members below; the quality spec (T1.7) MAY add members (this is the one deliberately open object in the model) |
| `warnings`         | Warning[]  | Req | sorted by (`code`, `subject`, `message`); may be empty                                                                  |
| `unmapped_devices` | Unmapped[] | Req | sorted by `instance_count` desc, then `key` asc                                                                         |

`summary` REQUIRED members: `chip_instances_total`, `chip_instances_mapped`, `chip_instances_ignored`, `chip_instances_unknown` (integers; total = mapped + ignored + unknown) and `mapped_instance_share` (number 0–1 per §8.4 — `(mapped + ignored) / total`, the project's headline metric).

`Warning`: `{ "code": "<SCREAMING_SNAKE>", "message": "<text>", ... }` plus Opt `subject` (entity id or repo-relative file path) and Opt `impact` (number). The code registry and thresholds are owned by T1.7 within this shape.

`Unmapped`: `{ "instance_count": <int>, "key": "<lookup key>", "machine_count": <int>, "sample_machines": [<machine ids, ≤ 5, sorted>] }` (same `sample_machines` field name as the worklist, §5.7, but dist-side it carries machine ids, not raw shortnames).

There is no `failures` field: a build with any failure-grade defect (§9) exits non-zero and publishes nothing, so a shipped report by construction contains only warnings.

---

## 6. The `unknown:*` convention

### 6.1 When it is minted

During BOM assembly (§6.5), every device reference in a filtered machine resolves through the device map. A lookup key with **no map entry** (neither mapped nor ignored) yields the chip ref `unknown:<lookup-key>`. Nothing is ever silently dropped: every device instance is mapped, ignored (with reason), or visibly unknown.

### 6.2 Device lookup keys

The device map, the worklist, and `unknown:` payloads share one key space:

- For a `device_refs[]` value: the key is the value verbatim (already a MAME shortname).
- For a `chips[]` element: `key = normalize_device_key(name)` where `normalize_device_key(s)` = lowercase `s`, then replace every maximal run of characters outside `[a-z0-9]` with a single `_`, then strip leading/trailing `_`. An empty result is a build failure. (Examples: `M68000` → `m68000`; `Sega 315-5124 VDP` → `sega_315_5124_vdp`.)

This normalization is part of the data contract: T2.4 emits worklist keys with it, curators map those exact keys, T6.1 looks them up. Changing the function is a breaking change to this spec.

### 6.3 Rules

- `unknown:` chip refs appear **only** in dist output (normalized BOMs, coverage `missing` lists, quality metrics) and, narrowly, in overlays as the `chip_id` of a row being corrected or removed (§7.4). An overlay MUST NOT _introduce_ a new `unknown:` row — a curator adding a row knows what the chip is and MUST curate a real (even if sparse) chip record first.
- `unknown:` ids MUST NEVER appear: as files under `data/chips/`; as device-map `chip_id` targets; in `implementation.chip_ids`; in equivalences; in `aliases.json`; in `core.machines`-adjacent data. CI MUST grep-gate `data/` for `"unknown:` outside `data/overlays/` (`UNKNOWN_IN_CURATED` failure).
- `unknown:` ids are ephemeral: mapping the device later replaces them with a real chip id in the next build. No alias is recorded for that transition (stub ids are not stable ids; their permanence guarantee is explicitly void, and their routes are expected to die).

### 6.4 Stub records

For every distinct `unknown:` ref in the built dataset, the pipeline materializes a stub chip **in dist only**:

```json
{
  "id": "unknown:sega_315_5197",
  "function": "unknown",
  "mame_devices": ["sega_315_5197"],
  "names": ["sega_315_5197"],
  "stub": true
}
```

`names[0]` is the most frequent raw display name for the key (ties broken lexicographically), else the key itself.

### 6.5 BOM assembly (normative algorithm for T6.1)

For each filtered raw machine, in order:

1. **Chip rows.** For each `chips[]` element in document order: `key = normalize_device_key(name)`; resolve via device map → `chip_id` (mapped), _skip_ (ignored), or `unknown:<key>`. Emit `{ chip_id, role: tag, clock_hz?, origin: "mame" }`.
2. **Device-ref counting.** For each `device_refs[]` value: resolve the key identically; ignored → skip; otherwise accumulate `count` per resolved chip ref.
3. **Dedup by subtraction.** For each chip ref from step 2, subtract the number of step-1 rows with the same `chip_id`; if the remainder `r` ≥ 1, emit `{ chip_id, role: "device", origin: "mame" }` with `count: r` when `r` ≥ 2. Rationale: `device_ref` lists every referenced device including those already described by `<chip>` elements; post-mapping subtraction removes the double count using the map itself as the vocabulary unifier. Residual mistakes (a `device_ref` that is genuinely a second physical instance) are overlay-correctable.
4. **Key uniqueness.** If two rows now share (`role`, `chip_id`), the build fails (`BOM_KEY_COLLISION`). (MAME tags are unique per machine, so this cannot occur from well-formed input.)
5. **Overlays** (§7), then family attachment (§5.8), `kind` (§5.4.1), then derived fields (coverage, cores).
6. **Sort** `chips` by (`role`, `chip_id`).

### 6.6 Quality accounting

Each `unknown:` **instance** (row `count` included) counts against `mapped_instance_share` as unknown (§5.12). Machines containing any `unknown:` row MUST have coverage `confidence` ≤ `medium`. `unmapped_devices` in the quality report is the dist-side view of the same keys, feeding the good-first-mapping issue generator.

---

## 7. Overlay merge semantics

Overlays are the only mechanism for correcting generated data (§4.2). They are applied by the normalizer after device mapping and before derivation (§6.5 step 5).

### 7.1 Model

An overlay's `patch` is a partial document merged into the target entity. The merge is defined per JSON type, recursively:

1. **Objects: deep merge, key by key.** For each key in the patch: apply the value rules below to the corresponding target key. Keys absent from the patch are untouched. Merging into an absent target key of object type treats the target as `{}` (this is how nested objects are introduced).
2. **Scalars (string / number / boolean): set.** The patch value replaces the target value, or introduces the key.
3. **`null`: delete.** A patch value of `null` deletes the target key. Chosen over a `$delete` marker for RFC 7386 (JSON Merge Patch) familiarity, and unambiguous here because no field in this model is nullable. Deleting a key that is **absent** is a build failure (`STALE_OVERLAY` — the overlay no longer does anything; see §7.5). Deleting a REQUIRED field survives to post-merge validation, which then fails.
4. **Arrays of scalars: replace is the DEFAULT.** A plain array value replaces the target array wholesale. Rationale: replace is idempotent and leaves no ordering/dedup ambiguity; scalar arrays in this model are small. Append/remove without restating is requested with a **wrapper object**: `{ "$append": [ ... ] }`, `{ "$remove": [ ... ] }`, or both members at once. Order of operations: `$remove` first, then `$append`, then canonical sort (unless the field is order-significant, §8.3, in which case appends go to the end). Every `$remove` value MUST be present in the target and every `$append` value MUST be absent — otherwise `STALE_OVERLAY` failure.
5. **Keyed arrays (arrays of objects with a declared identity key): merge by key.** Each patch element is matched against target elements by the array's key fields. Per element:
   - **no marker — correct:** a matching target element MUST exist (`STALE_OVERLAY` failure otherwise — this catches typos that would silently become additions); the element is deep-merged into the match per rules 1–4 (so `"clock_hz": null` inside an element deletes that field of the row).
   - **`"$add": true` — add:** a matching element MUST NOT exist (failure otherwise); the element minus the marker is inserted. It MUST carry all fields REQUIRED of the row.
   - **`"$remove": true` — remove:** a matching element MUST exist (failure otherwise); it is removed. Only the key fields and the marker are allowed in the element.
   - `$add` and `$remove` are mutually exclusive; key fields are immutable (change = `$remove` old + `$add` new).

The sentinels `$add`, `$remove`, `$append` are reserved: no data key may begin with `$` except `$schema` at file top level.

### 7.2 Declared keyed arrays

| Array           | Identity key        |
| --------------- | ------------------- |
| `machine.chips` | (`role`, `chip_id`) |

All other arrays in the model are scalar arrays (rule 4). Future keyed arrays MUST be declared here.

### 7.3 Overlayable surface

Machine overlays MAY touch: `name`, `kind`, `manufacturer`, `year`, `notes`, `chips` (and within a row: `clock_hz`, `count`, `note`). They MUST NOT touch: `id`, `source`, `platform_family` (owned by the families file), `cloneof`, `clone_count`, `mame_driver_status`, any derived field (`coverage`, `cores`), or `origin` within rows (the normalizer stamps `origin`: rows introduced by `$add` get `overlay`, corrected rows keep `mame`). A patch touching a forbidden key is a build failure (`OVERLAY_FORBIDDEN_FIELD`).

### 7.4 `unknown:` rows in overlays

An overlay MAY correct or `$remove` a row whose `chip_id` is `unknown:*` (e.g. delete a device MAME wrongly lists). It MUST NOT `$add` one (§6.3).

### 7.5 Ordering, conflicts, staleness

- **Application order** when multiple overlays target one entity: ascending **bytewise lexicographic order of the overlay file path relative to `data/overlays/`**. The `__qualifier` convention (§5.10) guarantees the base file sorts before its qualified siblings (`.` 0x2E < `_` 0x5F). Overlays for different targets are independent; any global processing order yields the same result.
- **Missing target: hard failure.** An overlay whose `target` (after alias resolution, §3.3) matches no machine in the filtered extract fails the build (`OVERLAY_TARGET_MISSING`).
- **Stale operation: hard failure.** Any `STALE_OVERLAY` condition from §7.1 (correct/remove with no match, `$add` with a match, `null`-delete of an absent key, `$append`/`$remove` value mismatch) fails the build.
- Justification: overlays encode human corrections; when a MAME upgrade renames a machine, fixes the underlying data, or restructures a BOM, a silently skipped or half-applied overlay would either mask the upstream fix or rot invisibly. Hard failure surfaces exactly which overlays need deletion or re-pointing **in the MAME-bump PR itself**, where the context is, and deleting a satisfied overlay is a one-line change. Error messages MUST name the overlay file, the target, and the failing operation.
- **Post-merge validation.** After all overlays for a target apply, the result MUST validate against the normalized machine schema (minus derived fields); violations fail the build naming the last-applied overlay file.

### 7.6 Machine creation (`create: true`)

An overlay with `create: true` mints a machine that does not exist in MAME. `target` MUST be a `custom:` id and MUST NOT already exist; the merge starts from `{}`; `patch` MUST produce all REQUIRED normalized fields except `id` and `source`, which the normalizer stamps (`source` per §5.4.2). Every `chips` element MUST carry `"$add": true` (explicit — nothing can be matched in an empty document). `create: true` with an existing target, or a `mame:` target, is a build failure.

### 7.7 Implementation overlays

`data/overlays/implementations/<impl-id>.json` exists solely to adjust **derived** fields of implementations — v1: `known_consumers` only, via the scalar-array wrapper (`$append` / `$remove` of core ids), applied after derivation (T4.5). All other implementation fields are curated in place, so patching them through an overlay is a build failure. Machine-overlay rules (§7.1, §7.5) apply unchanged.

### 7.8 Worked examples

Base (relevant excerpt of normalized `mame:outrun` before overlays):

```json
{
  "id": "mame:outrun",
  "chips": [
    { "chip_id": "z80", "clock_hz": 4000000, "origin": "mame", "role": "audiocpu" },
    { "chip_id": "m68000", "clock_hz": 10000000, "origin": "mame", "role": "maincpu" },
    { "chip_id": "ym2151", "clock_hz": 4000000, "origin": "mame", "role": "sound" },
    { "chip_id": "unknown:sega_315_5197", "origin": "mame", "role": "custom" }
  ]
}
```

**A — add a chip MAME omits** (`data/overlays/machines/outrun.json`):

```json
{
  "target": "mame:outrun",
  "patch": {
    "chips": [{ "$add": true, "chip_id": "sega-pcm", "role": "pcm" }]
  },
  "reason": "MAME abstracts the Sega PCM sound device on this driver; present on the physical board.",
  "source_urls": ["https://example.org/outrun-pcb-photo"]
}
```

After: the BOM gains `{ "chip_id": "sega-pcm", "origin": "overlay", "role": "pcm" }` (sorted into place).

**B — correct one field without restating the row** (`data/overlays/machines/outrun__audiocpu-clock.json`, applied after A by filename order):

```json
{
  "target": "mame:outrun",
  "patch": {
    "chips": [{ "chip_id": "z80", "clock_hz": 5000000, "role": "audiocpu" }]
  },
  "reason": "Clock divider documented incorrectly in MAME; measured 5 MHz on hardware."
}
```

After: the `audiocpu` row reads `"clock_hz": 5000000`; `origin` stays `"mame"`. Had the row not existed (e.g. after a MAME fix), the build would fail `STALE_OVERLAY` instead of silently adding a row.

**C — remove a chip MAME wrongly lists, and delete a field**:

```json
{
  "target": "mame:outrun",
  "patch": {
    "chips": [
      { "$remove": true, "chip_id": "unknown:sega_315_5197", "role": "custom" },
      { "chip_id": "ym2151", "clock_hz": null, "role": "sound" }
    ],
    "notes": "Deluxe cabinet variant; motor driver board tracked separately."
  },
  "reason": "315-5197 is not populated on this board revision; YM2151 clock unverified, removing until measured."
}
```

After: the `custom` row is gone; the `ym2151` row has no `clock_hz`; machine `notes` is set.

**D — create a non-MAME machine** (`data/overlays/machines/example-proto.json`):

```json
{
  "target": "custom:example-proto",
  "create": true,
  "patch": {
    "chips": [{ "$add": true, "chip_id": "z80", "role": "maincpu" }],
    "kind": "arcade",
    "name": "Example Prototype"
  },
  "reason": "Location-test board absent from MAME; documented from PCB photos.",
  "source_urls": ["https://example.org/proto-scan"]
}
```

**E — scalar-array wrapper on a derived field** (`data/overlays/implementations/jt51.json`):

```json
{
  "target": "jt51",
  "patch": {
    "known_consumers": {
      "$append": ["core:mister-x68000"],
      "$remove": ["core:mister-arcade-example"]
    }
  },
  "reason": "x68000 consumer missed by discovery; arcade-example is a false positive (bundles a different OPM)."
}
```

---

## 8. Determinism and serialization

Same inputs MUST produce byte-identical outputs; CI enforces this by building twice and byte-comparing `extract/` and `dist/` (`NONDETERMINISTIC_BUILD` failure).

### 8.1 JSON serialization contract

Applies to **every** JSON file in the repo — generated files by the emitter, curated files by the linter (T1.6):

- Encoding UTF-8, no BOM. Newline `\n` only. Exactly one trailing newline at EOF.
- Indentation: 2 spaces; no trailing whitespace. One key per line (i.e. `JSON.stringify(value, null, 2)` layout).
- String escaping: ECMAScript `JSON.stringify` minimal escaping; non-ASCII characters verbatim, never `\u`-escaped.
- Strict JSON: no comments, no duplicate keys.

### 8.2 Key order

In every object at every depth: the keys `$schema`, `id`, `mame_name`, `target` — in that order, when present — are hoisted first; all remaining keys follow in **bytewise lexicographic** order. One mechanical rule, human-friendly enough, trivially lintable.

### 8.3 Array order

Arrays are sorted, with exceptions only where order is data:

| Array                          | Order                                            |
| ------------------------------ | ------------------------------------------------ |
| `machines.raw.json` `machines` | `mame_name` asc                                  |
| raw `chips`, raw `device_refs` | **document order** (raw passthrough)             |
| normalized `machine.chips`     | (`role`, `chip_id`) asc                          |
| `chip.names`                   | **curated order** (first = primary display name) |
| `implementation.paths`         | **curated order** (first = top-level module)     |
| worklist `devices`             | total instances desc, `key` asc                  |
| quality `unmapped_devices`     | `instance_count` desc, `key` asc                 |
| quality `warnings`             | (`code`, `subject`, `message`) asc               |
| equivalence `classes`          | `chips[0]` asc (each `chips` sorted asc)         |
| equivalence `provides`         | (`provider`, `provides`) asc                     |
| coverage `missing`             | `chip_id` asc                                    |
| every other string[]           | bytewise asc, unique                             |

All string comparisons are bytewise on UTF-8 (no locale, no case folding).

### 8.4 Numbers

- All numbers MUST be finite; `NaN`/`±Infinity` are unrepresentable and MUST fail the emitter; `-0` MUST be normalized to `0`.
- Integers are emitted without decimal point or exponent.
- Non-integer numbers exist only where this spec says so: `coverage.percent` = `Math.round(x * 10) / 10` of the percentage; `mapped_instance_share` (and any ratio) = `Math.round(x * 10000) / 10000` of the 0–1 value. `Math.round` semantics (round half toward +∞) — all such values are non-negative.
- Serialization is ECMAScript Number-to-String (what `JSON.stringify` does): `81.8` stays `81.8`, `0.7` stays `0.7` (no padding).

### 8.5 Hashing and timestamps

- Chunk hashes: lowercase-hex SHA-256 of the exact file bytes; physical filenames embed the first 12 hex chars (§5.11); machine detail bucketing uses the first 2 hex chars of SHA-256 of the UTF-8 id.
- The only timestamp anywhere in generated output is `manifest.build_date`, derived per §5.11 (never wall-clock).

---

## 9. Pipeline order and gate registry

Normative stage order: fetch XML → stream-parse → filter → worklist → validate curated inputs → alias-resolve references (§3.3) → device-map + `unknown:` minting + dedup (§6.5) → overlays (§7) → families + `kind` → equivalence/coverage (T6.2) → Prospector (T6.3) → reverse indexes → quality report (T6.4) → emit chunks + SQLite + manifest (T6.5) → double-build compare.

**Failure gates** (exit non-zero, nothing published):

| Code                                                                   | Condition                                                                                                                                        |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SCHEMA_VIOLATION`                                                     | any file fails its schema, incl. post-merge machines                                                                                             |
| `SLUG_INVALID`                                                         | id fails its grammar, filename/stem mismatch, reserved-word id                                                                                   |
| `DUPLICATE_ID`                                                         | one id defined twice                                                                                                                             |
| `DANGLING_REFERENCE`                                                   | any cross-reference does not resolve (machine→chip, implementation→chip, core→machine, equivalence→chip, family→machine, alias→entity, map→chip) |
| `ALIAS_COLLISION`                                                      | alias key equals a live id, or alias chains                                                                                                      |
| `ROUTE_COLLISION`                                                      | two live-or-alias ids derive the same route (§2.4)                                                                                               |
| `FAMILY_CONFLICT`                                                      | machine claimed by two families (§5.8)                                                                                                           |
| `BOM_KEY_COLLISION`                                                    | duplicate (`role`, `chip_id`) in one machine (§6.5)                                                                                              |
| `OVERLAY_TARGET_MISSING` / `STALE_OVERLAY` / `OVERLAY_FORBIDDEN_FIELD` | §7.5, §7.3                                                                                                                                       |
| `UNKNOWN_IN_CURATED`                                                   | `unknown:` id inside `data/` outside overlay correct/remove positions (§6.3)                                                                     |
| `CHUNK_OVER_BUDGET`                                                    | chunk gzip size > 256 000 bytes                                                                                                                  |
| `NONDETERMINISTIC_BUILD`                                               | double-build byte mismatch                                                                                                                       |

**Warning gates** (recorded in the quality report; codes seeded here, definitions and thresholds owned by T1.7): `STALE_REFERENCE` (§3.3), `UNMAPPED_SHARE_HIGH`, `MISSING_METADATA`, `UNVERIFIED_LICENSE`, `UNVERIFIED_ACCURACY`, `ZERO_MAPPED_CHIPS`, `STALE_REVIEW`.

---

## 10. Schema registry

T1.2 implements, under `schemas/` (JSON Schema 2020-12, `additionalProperties: false` except `quality-report.summary`):

`chip.schema.json`, `implementation.schema.json`, `machine-raw.schema.json` (envelope + record), `machine.schema.json` (normalized), `core.schema.json`, `mame-device-map.schema.json`, `mame-devices-raw.schema.json`, `platform-families.schema.json`, `equivalences.schema.json`, `aliases.schema.json`, `overlay-machine.schema.json`, `overlay-implementation.schema.json`, `site-manifest.schema.json`, `quality-report.schema.json`.

This spec is versioned semver (T9.4): additive OPTIONAL fields bump minor; anything that changes meaning, grammar, key order, sort order, `normalize_device_key`, or merge semantics bumps major. `manifest.schema_version` and `quality-report.schema_version` track it.
