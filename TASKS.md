# BOM Squad — Task Breakdown

Companion to [PLAN.md](PLAN.md), structured for **ultracode** multi-agent execution. Each task names the cheapest agent tier that can complete it to the quality bar, its hard dependencies, and a testable acceptance gate.

## Agent tiers

| Tier          | Model ID           | Assign when the task is…                                                                                                  |
| ------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| **Haiku 4.5** | `claude-haiku-4-5` | Mechanical: scaffolding, templates, config, boilerplate docs                                                              |
| **Sonnet 5**  | `claude-sonnet-5`  | Standard engineering: well-specified scripts, UI components, CI, docs                                                     |
| **Opus 4.8**  | `claude-opus-4-8`  | Complex engineering or research-heavy curation: parsers, joiners, search, bulk chip metadata                              |
| **Fable 5**   | `claude-fable-5`   | Architecture-critical or domain-judgment-heavy: data model, coverage/ranking algorithms, identity mapping, quality audits |

Distribution: 9 Haiku · 28 Sonnet · 16 Opus · 8 Fable (61 tasks). Tasks marked **(human)** need the maintainer (credentials, announcements) and cannot be fully delegated.

## Standing rules (apply to every task)

1. **Generated ≠ curated.** Never hand-edit anything under `extract/` or `dist/`. Corrections are curated row
   files — `machine_correction`, `machine_chip_correction`, `machine_system` — not a merge/overlay step
   (data-model.md §1.5; see the 2026-07-22 note under Phase 1 below). There is no `data/mappings/` or
   `data/overlays/` merge algebra in the delivered model.
2. **Determinism.** Every pipeline stage: same inputs → byte-identical outputs. Sort all object keys and arrays by a stable criterion. This is an implicit acceptance criterion wherever files are produced.
3. **No guessed facts.** Curated data (chip specs, licenses, accuracy claims) must be verifiable; cite the source in the record's `notes` or the commit message. Omit an unknown field rather than guess — an absent value is honest, a wrong one poisons the dataset.
4. **Validate before commit.** Anything written under `data/` must pass `pipeline validate` locally.
5. **Stable IDs.** Never rename a slug after it ships; use the alias mechanism defined in T1.1.

---

## Phase 0 — Repo, CI & Azure setup

### T0.1 · Repo scaffolding — `Haiku 4.5`

**Depends:** —
Create the layout from PLAN §9: `schemas/`, `data/{chips,implementations,cores,mappings,overlays}/`, `extract/`, `pipeline/`, `site/`, `docs/`, `dist/` (gitignored except `.gitkeep`). Root `package.json` with npm workspaces (`pipeline`, `site`), `.gitignore`, `.editorconfig`, `.nvmrc` (Node 22). Each directory gets a one-paragraph `README.md` stating its edit policy (curated / generated / build output).
**Done when:** layout matches PLAN §9; `npm install` succeeds; every directory README states whether hand-edits are allowed.

### T0.2 · Licenses — `Haiku 4.5`

**Depends:** T0.1
`LICENSE-CODE` (MIT) and `LICENSE-DATA` (CC-BY-SA-4.0), plus a licensing section in the root README explaining the split and the per-record provenance requirement.
**Done when:** both files exist verbatim from official texts; README explains which license covers what.

### T0.3 · Root README — `Sonnet 5`

**Depends:** T0.1
Vision, architecture diagram (from PLAN §2), the Prospector pitch, quick-start (clone → install → build → serve), links to docs.
**Done when:** a newcomer can run the (placeholder) build from README instructions alone.

### T0.4 · CI skeleton — `Sonnet 5`

**Depends:** T0.1
GitHub Actions: lint (ESLint + Prettier), typecheck, test, build — path-filtered so site-only changes don't rerun the pipeline and vice versa.
**Done when:** a trivial PR gets green checks; an intentional lint error fails.

### T0.5 · Azure Static Web Apps provisioning + deploy — `Sonnet 5` (human: credentials)

**Depends:** T0.4
Script + doc for provisioning (`az staticwebapp create`, Free tier), `staticwebapp.config.json` with `navigationFallback` → `index.html` excluding `/site-data/*`, deploy workflow using `Azure/static-web-apps-deploy` with a hello-world placeholder. Maintainer supplies the deployment token as a repo secret.
**Done when:** placeholder is live on the `*.azurestaticapps.net` URL and a deep link (e.g. `/chip/ym2151`) serves the app shell, not a 404.

---

## Phase 1 — Data model, schemas & quality gates

> **Note (2026-07-22):** the nested-document model T1.1–T1.7 originally targeted (PLAN.md's old §3, a
> `core` table, `mappings/equivalences.json`, chunked `dist/site-data/`) was rejected in favor of a
> relational SQLite schema — see `docs/data-model.md` (spec 2.0.0), `docs/taxonomy.md` (spec 2.0.0),
> `docs/coverage.md` (spec 2.0.0, replacing the deleted `docs/equivalences.md`), and `docs/data-quality.md`
> (spec 2.0.0), plus `docs/adr/0001-browser-database.md` for how the SPA queries it. Those documents,
> `schemas/schema.sql`, `schemas/*.schema.json`, and `pipeline/src/validate/` are the delivered output of
> this phase; the task descriptions below are corrected to match rather than left describing the rejected
> design. `docs/data-model.md` §1.9 has the itemized deviation list this note summarizes.

### T1.1 · Canonical data model & ID conventions — `Fable 5`

**Depends:** T0.1
Finalize a normative spec (`docs/data-model.md`): every table, column, key and foreign key; slug grammar as a
regex (data-model.md §3.2); ID stability guarantees + alias mechanism for renames (`chip_name`/`system_name`,
§3.4); the generated-vs-curated boundary; and how corrections and system assignments work now that overlay
merge algebra is gone — three narrow tables (`machine_correction`, `machine_chip_correction`,
`machine_system`), applied by view at query time, not deep-merged at build time (§1.5).
**Done when:** the spec is unambiguous enough that T1.2 (schemas) and T6.1 (loader) can be implemented from
it without design questions coming back. Delivered: `docs/data-model.md` spec 2.0.0.

### T1.2 · JSON Schemas — `Opus 4.8`

**Depends:** T1.1
`schemas/schema.sql` (the normative SQLite DDL) plus one `schemas/*.schema.json` (JSON Schema 2020-12) per
table — `chip`, `system`, `machine`, `implementation` and their lookup/junction tables — validating the
row files under `data/`, and `rowfile.schema.json` as the per-file container. Enforce slug regexes, enums,
required fields, `additionalProperties: false`; a drift check (`diffRowSchemas()`) compares every row schema
against the live DDL so the two cannot silently disagree. See `schemas/README.md` for the full inventory.
**Done when:** an ajv-based test suite with valid + invalid fixtures per entity passes/fails exactly as
expected, and `diffRowSchemas()` fails the suite on any schema/DDL disagreement.

### T1.3 · Chip function taxonomy — `Opus 4.8`

**Depends:** T1.1
Enumerate and define the `chip_function` taxonomy in `docs/taxonomy.md` with a decision guide and worked
examples; seed `data/lookup/chip_function.json`. 26 values (`cpu`, `mcu`, `dsp`, `sound-fm`, `sound-psg`,
`sound-pcm`, `sound-speech`, `sound-wavetable`, `sound-dac`, `sound-analog`, `video-tilemap`, `video-sprite`,
`video-ppu`, `video-blitter`, `video-mixer`, `video-crtc`, `video-dac`, `protection`, `storage`, `rtc`,
`timer`, `io`, `dma`, `memory`, `custom`, `glue`), each with a `prospector_band`. Branch separators are
hyphens, per the lookup-table slug grammar, not the dots the original PLAN.md example used.
**Done when:** every chip on the MVP seed list (T3.3) classifies into exactly one value without ambiguity,
and `docs/taxonomy.md` matches `data/lookup/chip_function.json` exactly in both directions (verified
mechanically, not by eye).

### T1.4 · Equivalence model — `Fable 5`

**Depends:** T1.1
Design the semantics: the `chip_equivalence` table, `(from_chip_id, to_chip_id, kind)` where `kind` is
`equivalent` (symmetric, e.g. YM3438 ≈ YM2612) or `provides` (directional, e.g. a 68010 implementation can
serve a 68000 socket, not vice versa; a 2A03 is _not_ a plain 6502 — missing decimal mode, embedded APU).
Specify exactly how the coverage views (T6.2) consume both. Include ≥5 worked examples.
**Done when:** the four coverage views can be written directly from the spec; the worked examples become
their unit tests verbatim. Delivered: `docs/coverage.md` spec 2.0.0, replacing `docs/equivalences.md`.

### T1.5 · Finalize `docs/data-model.md` — `Sonnet 5`

**Depends:** T1.1–T1.4
Consolidate the model, taxonomy, and equivalence specs with a full column table per entity, cross-referenced
to schemas.
**Done when:** doc and schemas agree on every field (checked mechanically where possible).

### T1.6 · Validation CI + data linter — `Sonnet 5`

**Depends:** T1.2
`pipeline validate`: ajv over everything in `data/`, plus the row files loaded into a fresh in-memory database
built from `schema.sql` so `PRIMARY KEY`/`UNIQUE`/`CHECK`/`NOT NULL`/`PRAGMA foreign_key_check` do the
referential and constraint checking, plus the handful of lint rules a database cannot express. Wire into CI
as a required check.
**Done when:** a PR with a seeded broken fixture fails with an actionable message naming file, field, and
rule. Delivered: `pipeline/src/validate/`.

### T1.7 · Data quality spec — `Opus 4.8`

**Depends:** T1.1
Specify the quality model (schema + doc): the FAIL vs WARN conditions, the **mapped-instance-share** metric
(chip instances mapped or explicitly ignored, weighted by machine count), completeness dimensions per entity,
and initial thresholds. Most FAIL conditions v1 hand-wrote are now schema constraints (`CHECK`/`UNIQUE`/
`PRAGMA foreign_key_check`); what remains — size/determinism gates and the WARN codes a `CHECK` can't express
— is specified as SQL against a shipped view (`v_quality_warning`), not a bespoke checker.
**Done when:** T6.4 can implement the report from the spec alone; thresholds are in a config file, not code.
Delivered: `docs/data-quality.md` spec 2.0.0, `pipeline/config/quality-thresholds.json`,
`pipeline/src/db/thresholds.ts`.

---

## Phase 2 — MAME extraction pipeline

### T2.1 · MAME listxml acquisition — `Sonnet 5`

**Depends:** T0.1
Fetch the pinned MAME release's published listxml artifact (`mame0xxxlx.zip` from the official GitHub release), verify checksum, cache in `.cache/`. Pinned version lives in one config file.
**Done when:** `npm run mame:fetch` produces the verified XML; a second run is a cache hit; changing the pin fetches the new version.

### T2.2 · XML stream parser — `Opus 4.8`

**Depends:** T2.1, T1.2
SAX stream-parse the ~300 MB XML → `extract/machines.raw.json`: machine attrs (name, description, year, manufacturer, sourcefile, cloneof/romof, `isdevice`/`ismechanical`/`runnable`), `<chip>` entries (type/tag/name/clock), `<device_ref>`s, driver status. Single pass, memory-bounded (< 1 GB RSS).
**Done when:** a golden-fixture test (hand-built mini XML → expected JSON) passes; the full run completes and validates against the raw-machine schema.

### T2.3 · Filter rules — `Sonnet 5`

**Depends:** T2.2
Configurable filter config: parents-only by default (record clone count on the parent), drop `isdevice`/`ismechanical`, exclude-list by driver sourcefile for gambling/fruit-machine drivers (MAME XML has no genre field — document this limitation; catver.ini ingestion is a roadmap item). Log kept/dropped counts by reason.
**Done when:** filtered output is deterministic; the run log accounts for every dropped machine by reason.

### T2.4 · Device worklist — `Sonnet 5`

**Depends:** T2.3
Emit `extract/mame-devices.raw.json`: every distinct device/chip name across filtered machines with instance count, machine count, sample machine ids — sorted by impact. This is the curation worklist that drives Phase 3.
**Done when:** top of the list passes a sanity check (z80, m68000, ym2151-class devices dominate); file validates.

### T2.5 · Determinism + golden tests — `Sonnet 5`

**Depends:** T2.2–T2.4
CI job: run extraction twice, byte-compare outputs; golden fixtures for parser, filter, and worklist.
**Done when:** CI is green, and deliberately introducing an unsorted map iteration makes it fail.

### T2.6 · Monthly MAME refresh workflow — `Sonnet 5`

**Depends:** T2.5, T0.4
Scheduled Action: detect a new MAME release, bump the pin, regenerate `extract/`, open a PR with summary stats (machines added/removed, new unmapped devices by impact).
**Done when:** a manually-dispatched dry run opens a correctly-summarized PR.

---

## Phase 3 — Chip identity normalization (the real labor)

> **Note (2026-07-22):** T3.1–T3.5 below are corrected to target the tables `docs/data-model.md` actually
> delivered (`mame_device`, `chip`, `system`, `chip_equivalence`) instead of the deleted
> `mappings/*.json` files and the deleted `unknown:*` stub convention. Curation content and acceptance bar
> are unchanged — only the target artifact names are.

### T3.1 · Seed device map (top ~150 devices) — `Fable 5`

**Depends:** T2.4, T1.2
Map the top ~150 MAME device names by impact as `mame_device` row files (`data/mame_device/*.json`). Real chips → `chip_id`; MAME-internal artifacts (screen, speaker, palette, gfxdecode, timers…) → an explicit `ignore_reason` so the worklist shrinks honestly (`chip_id` and `ignore_reason` are mutually exclusive, per the table's `CHECK`). Uncertain devices get no row at all and stay unmapped with a research note — **no guesses**.
**Done when:** mapped-or-ignored instance share ≥ 70% of all chip instances across filtered machines (per T1.7 metric, §5); every non-obvious mapping carries a justification note.

### T3.2 · Unmapped-device worklist — `Sonnet 5`

**Depends:** T3.1
Implement in the extraction/load pipeline: a MAME device with no `mame_device` row (mapped or ignored) becomes a `machine_unmapped_device` row, never a synthetic chip. There is no `unknown:*` stub anywhere in the schema — taxonomy.md TB8: unresolvable means no `chip` row, not a guess. Unmapped devices surface as `v_mame_device_worklist`, the curation queue.
**Done when:** unit tests show an unmapped device flowing through to `machine_unmapped_device` and counted in `v_mame_device_worklist` and `v_system_coverage_by_kind.unmapped_device_count`.

### T3.3 · Seed chip catalog — `Opus 4.8`

**Depends:** T3.1, T1.3
Author `data/chip/*.json` row files (one per chip, per `chip.schema.json`) for every mapped chip: `manufacturer_id`, `model`, `family_id`, `function_id` (the taxonomy value, `docs/taxonomy.md`), `description`, `typical_clock_hz`, `package`, `year_introduced`, plus `chip_datasheet` rows for datasheet links. `mame_devices[]` isn't a chip field any more — it's the reverse of `mame_device.chip_id`, populated by T3.1. Research each; omit unknowns rather than guess.
**Done when:** all entries validate; a second-agent spot-check of 15 random chips finds zero factual errors in function/manufacturer.

### T3.4 · Systems — `Opus 4.8`

**Depends:** T2.3, T1.2
Curate `system` row files for major arcade systems (Sega System 1/16A/16B/18/24/X/Y, Out Run hw, CPS-1/2/3, Neo Geo MVS, Taito F2/F3, Konami GX + classics, Namco System 1/2, Irem M72/M92, Toaplan, Cave 68000, …) and consoles/handhelds — there is no separate `platform_family` concept; `system` **is** it (data-model.md §1.9). Bulk membership by driver sourcefile is `system_driver` (e.g. `outrun.cpp` → `sega-outrun-hw`); per-machine exceptions are `machine_system` rows, to avoid enumerating clones by hand.
**Done when:** ≥ 25 systems; every `system_driver`/`machine_system` assignment resolves against extracted machines; assignments spot-check clean.

### T3.5 · Equivalences curation — `Fable 5`

**Depends:** T1.4, T3.3
Populate `chip_equivalence` row files: YM2612/YM3438 (`kind = 'equivalent'`), 68000-family `provides`, Z80 clones (Sharp LH0080, NEC µPD780), 6502 family including the 2A03/decimal-mode caveat, HuC6280-vs-65C02, i8080/8085, 6809/HD6309, etc. Every edge carries the mandatory `note` with a citation.
**Done when:** all edges validate against the T1.4 (`docs/coverage.md`) semantics and none contradicts its worked examples; consumed cleanly by T6.2's verification tests.

### T3.6 · Mapping-contribution workflow doc — `Sonnet 5`

**Depends:** T3.1
`docs/contributing-mappings.md`: how to claim a device from the worklist, research it, add the mapping + chip entry, and pass validation.
**Done when:** dry run — an agent following only the doc successfully maps a held-out device end to end.

### T3.7 · BOM spot-check audit — `Fable 5`

**Depends:** T6.1
Sample 20 machines across families; verify normalized BOMs against MAME driver source and reference sites (reference-only — no scraping). File overlay corrections where MAME abstracts chips away (common for consoles).
**Done when:** audit report committed; error rate < 5% or corrections filed as overlays for the rest.

---

## Phase 4 — Implementation catalog

### T4.1 · Ingest jotego jt\* family — `Opus 4.8`

**Depends:** T1.2, T3.3
Records for JT51, JT12, JTOPL, JT49, JT89, JT5205, JT6295, JT7759, JTFRAME CPU wrappers, …: repo, paths, language, license (verified from the repo's LICENSE file), accuracy, target platforms.
**Done when:** ≥ 12 records validate and every `chip_id` resolves.

### T4.2 · Ingest canonical CPU cores — `Opus 4.8`

**Depends:** T1.2, T3.3
T80/TV80, fx68k, TG68K.C, ao68000, T65, Arlet 6502, MicroCore Labs set, ao486, plus non-jotego sound staples (POKEY, SID, …).
**Done when:** ≥ 20 records validate; licenses read from repos, not guessed.

### T4.3 · MiSTer IP auto-discovery — `Sonnet 5`

**Depends:** T1.2
Script: GitHub API over MiSTer-devel core repos; parse `.gitmodules` + `rtl/` listings; match against known implementation repos and heuristics; emit `extract/mister-ip-candidates.json` **for human review** — never straight into `data/`. Rate-limited, response-cached, deterministic given a cached snapshot.
**Done when:** a run surfaces known-true positives (e.g. jt51 inside CPS-1 core) and validates.

### T4.4 · Implementation metadata curation — `Opus 4.8`

**Depends:** T4.1–T4.3
Review candidates → promote to `data/implementations/`; fill accuracy enum and platforms; `verified_against_hardware: true` only with a citation.
**Done when:** every implementation has license + accuracy + at least one consumer or an explicit curation note.

### T4.5 · `known_consumers` derivation — `Sonnet 5`

**Depends:** T4.3, T6.1
Consumer back-links are **derived** at build time from discovery data (with curated additions via overlay), not hand-maintained in implementation files.
**Done when:** dist records carry derived consumers; any hand-maintained duplicates removed from curated files.

### T4.6 · Link-checker CI — `Haiku 4.5`

**Depends:** T0.4
Monthly job: HEAD-check every repo/datasheet URL in `data/`; open a single summary issue for failures.
**Done when:** a dry run with a seeded dead link produces the issue.

---

## Phase 5 — Core catalog

### T5.1 · MiSTer core enumeration — `Sonnet 5`

**Depends:** T1.2
Script: enumerate MiSTer-devel org repos → core records (name, repo, arcade/console classification from repo naming).
**Done when:** all `Arcade-*` and console core repos are captured and validate.

### T5.2 · Core → machine mapping — `Opus 4.8`

**Depends:** T5.1, T2.3
High-precision join: parse MRA files from the MiSTer distribution (`<setname>` = MAME shortname) to map arcade cores to machines automatically; hand-map or flag the remainder and console cores.
**Done when:** ≥ 90% of arcade cores machine-mapped via setnames; the rest carry an explicit `unmapped` flag with reason.

### T5.3 · Other platforms — `Opus 4.8`

**Depends:** T5.1
Add jotego JTBIN targets (MRA-based too), Analogue Pocket openFPGA cores (core `data.json` manifests), MiST, FPGAArcade Replay.
**Done when:** ≥ 3 platforms beyond MiSTer present with machine mappings where determinable.

### T5.4 · Open/closed-source flags — `Haiku 4.5`

**Depends:** T5.1–T5.3
Set `open_source` per core by checking for HDL sources vs releases-only (`.rbf`-only) repos; note the basis.
**Done when:** every core record has the flag; rbf-only repos are flagged closed with a note.

---

## Phase 6 — Build pipeline, coverage & Prospector

> **Note (2026-07-22):** T6.1, T6.2 and T6.5 targeted the nested-document normalizer, hand-written coverage
> engine and chunked-JSON emitter of PLAN.md's original §3. All three are gone. Loading row files into a
> database is already implemented (`pipeline/src/db/load.ts`, `pipeline/src/db/schema.ts`, used today by
> `pipeline validate`), and the four coverage views (`v_chip_satisfied`, `v_system_chip_coverage`,
> `v_prospector`, `v_chip_gap`) and the quality views (`v_quality_warning` and friends) already exist in
> `schemas/schema.sql`, delivered as part of Phase 1. What is genuinely left for this phase is narrower than
> originally scoped: turning `extract/` into row files via the device map, and a `pipeline build` command that
> assembles, VACUUMs and verifies `dist/bomsquad.sqlite`. Task descriptions below are corrected accordingly.

### T6.1 · Extraction → row files — `Opus 4.8`

**Depends:** T1.2, T2.3, T3.1, T3.2
Apply the MAME device map (the `mame_device` table, including ignore rows) to `extract/machines.raw.json`,
producing `machine`, `machine_chip` and `machine_unmapped_device` row files. This is the only join left to
write: corrections and system assignment are not a merge step against this output — they are curated row
files (`machine_correction`, `machine_chip_correction`, `machine_system`) that views apply at query time
(data-model.md §1.5), and loading everything into a database is already built and reused, not
re-implemented.
**Done when:** the produced row files validate (T1.6); loading them alongside curated `data/` into
`schema.sql` produces zero `PRAGMA foreign_key_check` violations; a double-run is byte-identical.

### T6.2 · Coverage views — `Fable 5`

**Depends:** T6.1, T1.4
Coverage is four `CREATE VIEW` statements over `chip_equivalence`, already written (`docs/coverage.md` §3.4,
mirrored verbatim in `schemas/schema.sql`) — there is no separate engine to build. This task is verification,
not authoring: prove the shipped views match `docs/coverage.md` §6's worked examples exactly, for every
`implementation_kind`, not just `fpga_hdl`.
**Done when:** a test asserts all of `docs/coverage.md` §6's worked examples against the live views and
passes; the assertion runs against `schema.sql`, not a re-implementation of the arithmetic.

### T6.3 · Prospector ranking — `Fable 5`

**Depends:** T6.2, T5.2
`v_prospector` (schema.sql) already ranks by `satisfied_share`, a plain ratio; it does not yet weight a
missing `custom`-function chip more heavily than a missing jellybean. This task adds that weighting as a
query-time computation (reading `chip_function.prospector_band` and a per-band weight from
`pipeline/config/`, per taxonomy.md §5) — not a stored score, and not a new base table. Bonus when a
system-mate already has a core; bonus when all CPUs + sound are implemented; penalty for low-confidence BOMs.
Every ranked entry carries an explainable score breakdown.
**Done when:** the top-25 list survives a documented domain sanity review; scores are reproducible; changing
a config weight changes results without a code or schema change.

### T6.4 · Integrity checks + quality report — `Sonnet 5`

**Depends:** T6.1, T1.7
The FAIL/WARN gates and the `v_quality_warning`/`v_quality_instance` views are already specified and
implemented (`docs/data-quality.md`, `schemas/schema.sql`). This task wires the remaining build-time-only
checks (size budget, non-deterministic-build detection) and emits `dist/quality-report.json` — the scalar
summary — per `docs/data-quality.md` §8.
**Done when:** each gate demonstrably trips on a seeded bad fixture; the report validates against its
schema; every scalar in it traces to a query against a shipped view, not a re-derivation.

### T6.5 · SQLite database build — `Opus 4.8`

**Depends:** T6.1–T6.4
Orchestrate the one build artifact: run the loader (`pipeline/src/db/load.ts`) over `data/` plus T6.1's
extraction-derived row files, apply `schema.sql`, `VACUUM`, and write `dist/bomsquad.sqlite`. No chunking, no
manifest, no per-entity file tree — see ADR 0001. Enforce the size budget ADR 0001's revisit trigger names
(32 MiB raw / 8 MiB brotli) as a build-time check, not a per-chunk one.
**Done when:** the database round-trips through the T7.2 client layer untransformed; a double-build is
byte-identical; `PRAGMA integrity_check` and `PRAGMA foreign_key_check` are both clean on the published file.

### T6.6 · Release publishing — `Haiku 4.5`

**Depends:** T6.5
Action: on merge to main, publish `dist/` as a date-tagged GitHub Release.
**Done when:** a dry run produces a release with all artifacts attached.

### T6.7 · Consumer docs — `Sonnet 5`

**Depends:** T6.5
`docs/consuming-the-dataset.md`: how to fetch `dist/bomsquad.sqlite` and query it directly (Node's
`node:sqlite`, Python's `sqlite3`, or any SQLite client — no proprietary format to parse), the published
views as the stable query surface, and versioning (`dataset_meta`).
**Done when:** includes a working example script that downloads a release and runs a query.

---

## Phase 7 — Angular frontend

### T7.1 · Angular scaffold — `Sonnet 5`

**Depends:** T0.5
Angular 21+ (standalone components, signals, built-in control flow), strict TS, ESLint/Prettier, lazy routes for every view in PLAN §5, base layout + nav, dark theme default with toggle.
**Done when:** `ng build` is clean; all routes render placeholders; deployed skeleton scores ≥ 90 Lighthouse performance.

### T7.2 · Data access layer — `Opus 4.8`

**Depends:** T6.5, T7.1
Per [ADR 0001](docs/adr/0001-browser-database.md): load `@sqlite.org/sqlite-wasm`, `fetch` `dist/bomsquad.sqlite` once at boot, open it in memory with `sqlite3_deserialize`, and expose typed query functions over the shipped views and tables — no manifest, no chunk cache. TS row types are still **generated from the JSON Schemas** (single source of truth — no hand-drift). Signal-based stores wrap query results; loading/error states cover the one fetch that can fail.
**Done when:** types are codegen'd in the build; unit tests run against a fixture database (not fixture chunks); a failed database fetch or a query against a missing view surfaces a user-visible error state, not a blank page.

### T7.3 · Global search — `Opus 4.8`

**Depends:** T7.2
Unified search across chips/machines/implementations/systems runs as SQL against the same in-browser database T7.2 opened — no separate index to lazy-load. Keyboard driven (`/` to focus, arrows, enter).
**Done when:** fixture-database queries return correct typed results with working links; no second network fetch happens before or during first search.

### T7.4 · Chip browser + detail — `Sonnet 5`

**Depends:** T7.2
Browser: filter by function, manufacturer, implemented-status; sort by machine usage. Detail: specs, implementations with license/accuracy badges, machines using it, equivalence notes.
**Done when:** matches PLAN §5 spec; permalink refresh works on the deployed site (SWA fallback).

### T7.5 · Machine browser + detail — `Sonnet 5`

**Depends:** T7.2
Browser: filter by kind, manufacturer, year range, family, coverage %, has-core. Detail: full BOM table — each row links its implementation(s) or shows a red "missing" badge — plus MAME driver link and existing cores.
**Done when:** matches PLAN §5 spec; coverage badges consistent with T6.2 outputs.

### T7.6 · Platform family pages — `Sonnet 5`

**Depends:** T7.2
Family page: shared chipset, member machines, family-level coverage.
**Done when:** matches PLAN §5 spec with working cross-links.

### T7.7 · The Prospector view — `Opus 4.8`

**Depends:** T7.2, T6.3
The flagship — polish this most. Ranked list with coverage badges and what's-missing inline; filters (target platform, kind, manufacturer) reflected in the URL for shareable permalinks; expandable score breakdown per board.
**Done when:** deep links reproduce the exact filtered view; score breakdown matches T6.3 data; UX review pass done.

### T7.8 · Implementation browser — `Sonnet 5`

**Depends:** T7.2
Filter by language, license, accuracy, author; link out to repos and consumers.
**Done when:** matches PLAN §5 spec.

### T7.9 · Dashboard / home — `Sonnet 5`

**Depends:** T7.2
Headline stats queried live from the database (entity counts, `dist/quality-report.json`'s scalars), top newly-viable boards, small coverage charts.
**Done when:** all numbers trace to a query or to the quality report; nothing hardcoded.

### T7.10 · Responsive + accessibility pass — `Sonnet 5`

**Depends:** T7.4–T7.9
Mobile layouts, keyboard navigation, WCAG AA contrast in both themes.
**Done when:** axe-core CI check passes; views usable at 375 px width.

### T7.11 · Production SWA config — `Sonnet 5`

**Depends:** T7.1, T6.5
Finalize `staticwebapp.config.json` per [ADR 0001](docs/adr/0001-browser-database.md)'s consequences: `Content-Security-Policy` `script-src` needs `'wasm-unsafe-eval'` for the wasm module to compile; `mimeTypes` needs `.wasm` → `application/wasm` and a type for `bomsquad.sqlite`; `navigationFallback` must exclude the (content-hashed, immutably-cached) database path from the SPA rewrite, same as the placeholder `/site-data/*` rule it replaces.
**Done when:** headers verified with curl against the deployed site; a dataset redeploy invalidates only the database's hashed path, not the whole app shell.

---

## Phase 8 — Community & contribution workflow

### T8.1 · CONTRIBUTING.md — `Sonnet 5`

**Depends:** T1.5, T3.6
How to add a chip, implementation, mapping, or overlay; local validation; PR expectations.
**Done when:** covers all four contribution types with copy-pasteable examples.

### T8.2 · PR + issue templates — `Haiku 4.5`

**Depends:** T8.1
Templates: "Add implementation", "Map MAME device", "Correct BOM", generic PR checklist.
**Done when:** templates render correctly on GitHub.

### T8.3 · Required status checks — `Haiku 4.5` (human: repo settings)

**Depends:** T1.6, T4.6
Script/doc (`gh api`) to mark schema validation + link check as required; maintainer applies branch protection.
**Done when:** an invalid-data PR is blocked from merging.

### T8.4 · Good-first-mapping issue generator — `Sonnet 5`

**Depends:** T2.4, T6.4
Action: auto-open labeled issues for the highest-impact unmapped devices (top N, deduped against open issues), each pre-filled with usage stats and research pointers.
**Done when:** dry run generates correct, deduplicated issues.

### T8.5 · Announce & collect feedback — **(human)**

**Depends:** T9.2
MiSTer FPGA forum, retro FPGA Discords, r/fpgagaming. Agents may draft the posts.

---

## Phase 9 — Launch & maintenance

### T9.1 · End-to-end data quality audit — `Fable 5`

**Depends:** T3.7, T6.5, T7.7 (site live with real data)
Independent adversarial audit: re-verify a fresh sample of chips/machines/implementations against sources; hand-check the Prospector top 25; clean-clone rebuild reproduces `dist/` byte-identically; review quality-report thresholds against reality.
**Done when:** written audit committed to `docs/`; all critical findings fixed; mapped-instance share ≥ 75% and zero dangling references at MVP.

### T9.2 · MVP launch checklist — `Sonnet 5`

**Depends:** T9.1
Execute PLAN §7 item by item against the live site; file issues for gaps.
**Done when:** every §7 item verified live or tracked with an issue.

### T9.3 · Automation schedules — `Haiku 4.5`

**Depends:** T2.6, T4.3, T4.6
Confirm cron workflows enabled: monthly MAME refresh, weekly discovery scrape, monthly link check.
**Done when:** all three have a successful scheduled or dispatched run.

### T9.4 · Versioning policy — `Haiku 4.5`

**Depends:** T6.6
`docs/versioning.md`: semver on schemas, date tags on data releases, deprecation path for slug renames (aliases from T1.1).
**Done when:** doc exists and release workflow follows it.

---

## Execution waves (parallelism guide)

Tasks within a wave can run concurrently; waves are ordered by hard dependencies. Curation tracks (3/4/5) are mutually independent once Phase 1–2 land.

| Wave | Tasks                                           |
| ---- | ----------------------------------------------- |
| 1    | T0.1 → then T0.2, T0.3, T0.4, T1.1 in parallel  |
| 2    | T0.5, T1.2, T1.3, T1.4, T1.7, T2.1              |
| 3    | T1.5, T1.6, T2.2, T7.1                          |
| 4    | T2.3 → T2.4, T2.5 · T4.3, T5.1                  |
| 5    | T2.6, T3.1, T4.1, T4.2, T5.2, T5.3, T5.4        |
| 6    | T3.2, T3.3, T3.4, T3.6 · T4.4                   |
| 7    | T3.5, T6.1 → T4.5, T6.2, T6.4                   |
| 8    | T3.7, T6.3 → T6.5 → T6.6, T6.7, T7.2            |
| 9    | T7.3–T7.9 in parallel, then T7.10, T7.11        |
| 10   | T8.1–T8.4 (can start any time after their deps) |
| 11   | T9.1 → T9.2 → T8.5, T9.3, T9.4                  |

**Critical path:** T1.1 → T1.2 → T2.2 → T2.3 → T3.1 → T6.1 → T6.2 → T6.3 → T6.5 → T7.2 → T7.7 → T9.1.
