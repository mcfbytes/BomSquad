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

1. **Generated ≠ curated.** Never hand-edit anything under `extract/` or `dist/`. Corrections go in `data/mappings/` or `data/overlays/`.
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

### T1.1 · Canonical data model & ID conventions — `Fable 5`

**Depends:** T0.1
Finalize PLAN §3 into a normative spec (draft of `docs/data-model.md`): every entity and field (required/optional), slug grammar as a regex, ID stability guarantees + alias mechanism for renames, route-slug derivation for URLs (e.g. `mame:outrun` → `/machine/outrun`), the `unknown:*` convention, the generated-vs-curated boundary, and **overlay merge semantics** (deep-merge rules, array replace-vs-append, delete markers).
**Done when:** the spec is unambiguous enough that T1.2 (schemas) and T6.1 (normalizer) can be implemented from it without design questions coming back.

### T1.2 · JSON Schemas — `Opus 4.8`

**Depends:** T1.1
`schemas/*.schema.json` (JSON Schema 2020-12) for: chip, implementation, machine (raw + normalized), core, device-map, platform-families, equivalences, overlay, site-data manifest, quality-report. Enforce slug regexes, enums, required fields, `additionalProperties: false`.
**Done when:** an ajv-based test suite with valid + invalid fixtures per entity passes/fails exactly as expected.

### T1.3 · Chip function taxonomy — `Opus 4.8`

**Depends:** T1.1
Enumerate and define the `function` taxonomy (`cpu`, `mcu`, `sound.fm`, `sound.psg`, `sound.pcm`, `sound.dac`, `video.tilemap`, `video.sprite`, `video.ppu`, `video.blitter`, `io`, `timer`, `custom`, `glue`, …) in `docs/taxonomy.md` with a decision guide and examples; encode the enum in the chip schema.
**Done when:** every chip on the MVP seed list (T3.3) classifies into exactly one value without ambiguity.

### T1.4 · Equivalence model — `Fable 5`

**Depends:** T1.1
Design the semantics: symmetric equivalence classes (YM3438 ≈ YM2612) **and** directional `provides` edges (a 68010 implementation can serve a 68000 socket, not vice versa; a 2A03 is _not_ a plain 6502 — missing decimal mode, embedded APU). Specify exactly how coverage math consumes both. Include ≥5 worked examples.
**Done when:** T6.2 can implement coverage directly from the spec; the worked examples become its unit tests.

### T1.5 · Finalize `docs/data-model.md` — `Sonnet 5`

**Depends:** T1.1–T1.4
Consolidate the model, taxonomy, and equivalence specs with a full JSON example per entity, cross-referenced to schemas.
**Done when:** doc and schemas agree on every field (checked mechanically where possible).

### T1.6 · Validation CI + data linter — `Sonnet 5`

**Depends:** T1.2
`pipeline validate`: ajv over everything in `data/`, plus lint rules — slug matches filename, keys sorted, clock sanity (kHz–MHz range), year sanity (1970–2005 warn), duplicate names. Wire into CI as a required check.
**Done when:** a PR with a seeded broken fixture fails with an actionable message naming file, field, and rule.

### T1.7 · Data quality spec — `Opus 4.8`

**Depends:** T1.1
Specify `quality-report.json` (schema + doc): the fail vs warn conditions from PLAN §3.8, the **mapped-instance-share** metric (chip instances mapped or explicitly ignored, weighted by machine count), completeness dimensions per entity, and initial thresholds.
**Done when:** T6.4 can implement the report from the spec alone; thresholds are in a config file, not code.

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

### T3.1 · Seed device map (top ~150 devices) — `Fable 5`

**Depends:** T2.4, T1.2
Map the top ~150 MAME device names by impact in `mappings/mame-device-map.json`. Real chips → canonical slugs; MAME-internal artifacts (screen, speaker, palette, gfxdecode, timers…) → explicit `ignore` entries so the worklist shrinks honestly. Uncertain devices stay unmapped with a research note — **no guesses**.
**Done when:** mapped-or-ignored instance share ≥ 70% of all chip instances across filtered machines (per T1.7 metric); every non-obvious mapping carries a justification note.

### T3.2 · `unknown:*` passthrough — `Sonnet 5`

**Depends:** T3.1
Implement the convention in the pipeline library: unmapped, non-ignored devices become `unknown:<mame-name>` chip refs and materialize as auto-generated stub chips in dist (never in `data/`). Nothing is silently dropped.
**Done when:** unit tests show an unmapped device flowing through to a machine BOM as `unknown:*`; quality report counts them.

### T3.3 · Seed chip catalog — `Opus 4.8`

**Depends:** T3.1, T1.3
Author `data/chips/*.json` for every mapped chip: manufacturer, model, family, function, description, typical clock, year, package, datasheet links, `mame_devices`. Research each; omit unknowns rather than guess.
**Done when:** all entries validate; a second-agent spot-check of 15 random chips finds zero factual errors in function/manufacturer.

### T3.4 · Platform families — `Opus 4.8`

**Depends:** T2.3, T1.2
Curate `mappings/platform-families.json` for major arcade systems (Sega System 1/16A/16B/18/24/X/Y, Out Run hw, CPS-1/2/3, Neo Geo MVS, Taito F2/F3, Konami GX + classics, Namco System 1/2, Irem M72/M92, Toaplan, Cave 68000, …) and consoles/handhelds. Membership by explicit machine ids **or** driver-sourcefile rules (e.g. `outrun.cpp` → `sega-outrun-hw`) to avoid enumerating clones.
**Done when:** ≥ 25 families; every membership resolves against extracted machines; assignments spot-check clean.

### T3.5 · Equivalences curation — `Fable 5`

**Depends:** T1.4, T3.3
Populate `mappings/equivalences.json`: YM2612/YM3438, 68000-family `provides`, Z80 clones (Sharp LH0080, NEC µPD780), 6502 family including the 2A03/decimal-mode caveat, HuC6280-vs-65C02, i8080/8085, 6809/HD6309, etc. Every edge justified in a note.
**Done when:** all edges validate against the T1.4 semantics and none contradicts its worked examples; consumed cleanly by T6.2 tests.

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

### T6.1 · Normalizer/joiner — `Opus 4.8`

**Depends:** T1.2, T2.3, T3.1, T3.2
Join `extract/` + `data/` + overlays into the canonical normalized model: apply device map (with ignores), materialize `unknown:*` stubs, apply overlays per T1.1 merge semantics, attach families and cores. Emit the SQLite export.
**Done when:** output validates against normalized schemas; integrity checks (T6.4) pass; double-run is byte-identical.

### T6.2 · Coverage engine — `Fable 5`

**Depends:** T6.1, T1.4, T3.5
Per machine and per family: mapped chip count, implemented count (via implementations + equivalence/`provides` edges), coverage %, missing list with per-chip reason, and a confidence level that degrades when `unknown:*` chips are present. Must honor T1.4 semantics exactly.
**Done when:** unit tests include all T1.4 worked examples; coverage for 10 hand-computed machines matches expected values exactly.

### T6.3 · Prospector ranking — `Fable 5`

**Depends:** T6.2, T5.2
Rank core-less machines per target platform by weighted viability: heavy penalty for missing `custom`-function chips, light for jellybeans; bonus when a family-mate already has a core; bonus when all CPUs + sound are implemented; penalty for low-confidence BOMs. Weights live in a config file. Every ranked entry carries an explainable score breakdown.
**Done when:** the top-25 list survives a documented domain sanity review; scores are reproducible; changing a config weight changes results without a code change.

### T6.4 · Integrity checks + quality report — `Sonnet 5`

**Depends:** T6.1, T1.7
Implement the fail/warn gates from PLAN §3.8 and emit `dist/quality-report.json` per the T1.7 spec.
**Done when:** each gate demonstrably trips on a seeded bad fixture; the report validates against its schema.

### T6.5 · Chunked site-data emitter — `Opus 4.8`

**Depends:** T6.1–T6.4
Emit `dist/site-data/` per PLAN §3.7: manifest with logical→hashed-path map, indexes, sharded machine details, family/implementation/core files, prospector chunks, serialized search-index chunks, stats. Enforce the ≤ 250 KB gzipped budget (fail → re-shard). Content-hashed filenames for everything but `manifest.json`.
**Done when:** all chunks under budget; manifest hashes verify against files; deterministic; a fixture dataset round-trips through the T7.2 client layer untransformed.

### T6.6 · Release publishing — `Haiku 4.5`

**Depends:** T6.5
Action: on merge to main, publish `dist/` as a date-tagged GitHub Release.
**Done when:** a dry run produces a release with all artifacts attached.

### T6.7 · Consumer docs — `Sonnet 5`

**Depends:** T6.5
`docs/consuming-the-dataset.md`: chunk format, manifest contract, SQLite schema, versioning.
**Done when:** includes a working example script that downloads a release and runs a query.

---

## Phase 7 — Angular frontend

### T7.1 · Angular scaffold — `Sonnet 5`

**Depends:** T0.5
Angular 21+ (standalone components, signals, built-in control flow), strict TS, ESLint/Prettier, lazy routes for every view in PLAN §5, base layout + nav, dark theme default with toggle.
**Done when:** `ng build` is clean; all routes render placeholders; deployed skeleton scores ≥ 90 Lighthouse performance.

### T7.2 · Data access layer — `Opus 4.8`

**Depends:** T6.5, T7.1
Typed data services: TS types **generated from the JSON Schemas** (single source of truth — no hand-drift), manifest fetch at boot, chunk fetch with in-memory cache keyed by content hash, signal-based stores, loading/error states.
**Done when:** types are codegen'd in the build; unit tests run against fixture chunks; a missing chunk surfaces a user-visible error state, not a blank page.

### T7.3 · Global search — `Opus 4.8`

**Depends:** T7.2
Unified search across chips/machines/implementations/cores/families over the prebuilt index chunks; lazy-load index on first interaction; keyboard driven (`/` to focus, arrows, enter).
**Done when:** fixture-dataset queries return correct typed results with working links; no index bytes load before first search.

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
Headline stats from `stats.json`, top newly-viable boards, small coverage charts.
**Done when:** all numbers trace to the quality report / stats chunk; nothing hardcoded.

### T7.10 · Responsive + accessibility pass — `Sonnet 5`

**Depends:** T7.4–T7.9
Mobile layouts, keyboard navigation, WCAG AA contrast in both themes.
**Done when:** axe-core CI check passes; views usable at 375 px width.

### T7.11 · Production SWA config — `Sonnet 5`

**Depends:** T7.1, T6.5
Finalize `staticwebapp.config.json`: immutable long-cache headers for hashed `/site-data/*` chunks, short-TTL for `manifest.json`, SPA fallback excluding `/site-data/*`, MIME types.
**Done when:** headers verified with curl against the deployed site; a dataset redeploy invalidates only the manifest.

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
