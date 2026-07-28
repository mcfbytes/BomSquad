# BOM Squad — Project Plan

**An open database mapping arcade boards and consoles to their chip bills-of-materials, mapping those chips to existing open-source FPGA implementations, and surfacing boards that are ready to become cores but don't have one yet.**

---

## 1. Vision & Goals

### Primary goals

1. **Chip catalog** — a canonical registry of the CPUs, sound chips, video chips, and notable custom silicon used in classic arcade and console hardware, with rich metadata (manufacturer, model, family, function, clock, package, description).
2. **Implementation index** — for each chip, links to known open-source HDL implementations (VHDL/Verilog/SystemVerilog): repo, file path, language, license, accuracy level, known consumers (which cores already use it).
3. **Board/console BOM database** — for each machine, the list of chips it uses, largely auto-extracted from MAME and enriched by curation.
4. **The Prospector** — the killer query: rank core-less boards by implementation coverage (`implemented chips / total chips`) to surface low-hanging fruit for new core developers.
5. **A searchable static website** presenting all of the above across every dimension (by chip, by board, by platform family, by manufacturer, by coverage).

### Non-goals (v1)

- Hosting any HDL itself (links only — avoids license aggregation issues).
- Cycle-accuracy verification or quality scoring beyond self-reported/curated notes.
- ROMs, game metadata, or anything MAME already does better.
- A server-side backend. Everything is static: Git is the database of record, CI builds the dataset, the site is client-side only.

### Guiding principles

- **Git as source of truth.** All curated data is human-readable JSON in the repo, reviewed via PRs.
- **Generated ≠ curated.** Machine-extracted data (MAME) is never hand-edited; corrections happen in overlay/mapping files so extraction can be re-run on every MAME release.
- **Stable IDs everywhere.** Every chip, implementation, board, and core gets a permanent slug ID so cross-references never break.
- **Licenses respected.** Data files under CC-BY-SA (or CC0 — decide early), code under MIT/GPL as appropriate; scraped sources checked for terms before ingestion.

---

## 2. Architecture Overview

> **Note (2026-07-22):** Phase 1 replaced the nested-document model this diagram originally showed (chunked
> `dist/site-data/` JSON, a separate `BUILD PIPELINE (normalize, join, validate, derive)` stage) with a
> relational SQLite schema. `dist/bomsquad.sqlite` is now the one build artifact the site consumes, loaded
> and queried directly in the browser (ADR 0001). Diagram and bullets below reflect that. See
> [`docs/data-model.md`](docs/data-model.md) for the normative schema and §3 below for a summary.

```
                          ┌─────────────────────────┐
   MAME -listxml ────────►│  extract/ (generated)   │
   (per-release dump)     │  machines.raw.json      │
                          └───────────┬─────────────┘
                                      │
   data/ (curated, in Git,            ▼
   one row-file per table —  ┌─────────────────────┐
   see schemas/README.md)    │   BUILD PIPELINE    │──► dist/bomsquad.sqlite
                              │ (load rows, apply   │      (primary artifact —
                              │  schema.sql, run    │       the site queries it
                              │  quality views)     │       directly, ADR 0001)
                              └─────────────────────┘──► dist/quality-report.json
                                      │
                                      ▼
                          ┌─────────────────────────┐
                          │  site/ (Angular SPA)    │
                          │  in-browser SQLite,     │
                          │  Azure Static Web Apps  │
                          └─────────────────────────┘
```

- **`data/`** — curated row files, one JSON file per row, grouped by table (`schemas/README.md`); PR-reviewed.
  There is no separate `cores/`, `mappings/`, or `overlays/` concept in the delivered model — a "core" is an
  `implementation` row with `kind_id = 'fpga_hdl'`, equivalence is the `chip_equivalence` table, and
  corrections are `machine_correction` / `machine_chip_correction` / `machine_system` row files
  (data-model.md §1.9 has the full deviation list).
- **`extract/`** — deterministic outputs of the MAME parser (and other scrapers), committed for diff-ability or rebuilt in CI.
- **`dist/`** — build outputs: `bomsquad.sqlite` (the primary artifact, loaded whole by the site — no chunking,
  no manifest) and the data quality report (§3.5). Published as versioned release artifacts.
- **`site/`** — Angular SPA, deployed to Azure Static Web Apps.

---

## 3. Data Model

> **Note (2026-07-22):** §3.1–§3.8 originally specified a nested-document JSON model (one big object per
> chip/implementation/machine/core, arrays of sub-objects inline, a chunked JSON publishing format). That
> model was rejected in favor of a normalized relational schema — the maintainer's words were "we are
> violating 1NF and 2NF in various ways, dumb it down please." [`docs/data-model.md`](docs/data-model.md)
> (spec 2.0.0) is now the normative source for every table, column, key and view; this section is a summary
> that points to it rather than a second copy of it. `docs/data-model.md` §1.9 lists every deviation from the
> table set this section used to propose, including the two deletions below.

### 3.1 The relational model, in brief

Nine lookup tables (`manufacturer`, `license`, `chip_function`, `chip_family`, `chip_role`, `system_kind`,
`hdl_language`, `fpga_platform`, `implementation_kind`, `accuracy_level`) hold controlled vocabularies as
data, not enums — adding a value is an `INSERT`, never a schema or code change. Around them:

- **`chip`** — one row per canonical part, classified by `function_id` (the taxonomy, [`docs/taxonomy.md`](docs/taxonomy.md)) with `chip_datasheet`, `chip_name` and `chip_equivalence` as child/junction tables fixing the array fields the old `chips` JSON example used to hold inline.
- **`system`** (curated board/console family, e.g. `sega-system16a`) and **`machine`** (one row per MAME machine) are two tables, not one — a system groups many machines and carries its own curated BOM (`system_chip`) that machines inherit unless they override a chip (`machine_chip`). This is what §3.3's `platform_family` string used to approximate.
- **`implementation`** — one generic table for every "somebody built this" fact, discriminated by `kind_id`: `fpga_hdl`, `software_emulation`, `original_silicon`, and any kind added later by inserting a row. **There is no `core` table and no privileged FPGA case anywhere in the schema** — what §3.4 called a "core" is an `implementation` row with `kind_id = 'fpga_hdl'` plus a row in `implementation_system`. `implementation_chip`, `implementation_path`, `implementation_platform`, `implementation_machine` and `implementation_dependency` are the junctions that fix `chip_ids[]`, `paths[]`, `target_platforms[]`, `machines[]` and `known_consumers[]` from the old nested shape.
- **`chip_equivalence`** replaces `mappings/equivalences.json`: `(from_chip_id, to_chip_id, kind)` where `kind` is `equivalent` (symmetric) or `provides` (directional) — see [`docs/coverage.md`](docs/coverage.md) for the semantics and worked examples that used to live in the now-deleted `docs/equivalences.md`.

Adding a new arcade system and linking its documented chips to it is the whole curation effort — insert a
`system` row, insert or reuse `chip` rows, insert `system_chip` rows. There is no separate step to make FPGA
coverage visible; it falls out of the views in §3.3 the moment an `implementation_system` row exists.

### 3.2 Corrections and assignments

`overlays/machines/*.json`'s free-form merge algebra is gone. In its place, three narrow tables, each a
plain row file: `machine_correction` (scalar fixes: name/year/manufacturer, with a mandatory `reason`),
`machine_chip_correction` (BOM row add/remove/set, with a mandatory `reason`), and `machine_system` (which
`system` a machine belongs to, when the bulk default by driver sourcefile — `system_driver` — is wrong or
absent; `reason` here is optional because assigning a system isn't correcting a mistake). Views apply these
at query time (`v_machine`, `v_machine_bom`); nothing is merged or rewritten at build time.

### 3.3 Coverage and the Prospector

Coverage is **views**, not a computed-and-stored engine: four `CREATE VIEW` statements in `docs/coverage.md`
§3.4 answer "does an implementation exist for this socket," rank systems with no FPGA core by chip coverage,
and list the highest-impact unimplemented chips. There is no `satisfied()` function, no closure computation,
and no coverage numbers embedded in machine/system records — a query against the database _is_ the Prospector.

### 3.4 Site data format: one SQLite file

The chunked-JSON publishing format (`dist/site-data/`, a `manifest.json`, content-hashed shards, a 250 KB
gzip budget per chunk) is deleted. Per [ADR 0001](docs/adr/0001-browser-database.md), the build emits one
file, **`dist/bomsquad.sqlite`**, and the SPA fetches it whole and runs SQL against it in the browser via
`@sqlite.org/sqlite-wasm` (`sqlite3_deserialize`, no OPFS, no COOP/COEP). `dist/quality-report.json` — a
handful of scalars for CI gates and a status badge — is the only other published file.

### 3.5 Data quality gates (schema-enforced where possible)

Most of what this section used to describe as hand-written build gates is now a schema constraint: `CHECK`,
`UNIQUE`, `NOT NULL`, `STRICT` typing and `PRAGMA foreign_key_check` catch schema violations, malformed
slugs, and dangling cross-references structurally — see [`docs/data-quality.md`](docs/data-quality.md) §2 for
the itemized "what the schema now enforces" ledger. What remains a build-time check: chunk/file-size and
determinism gates (§3.7 of `docs/data-quality.md`), and the WARN conditions a `CHECK` can't express —
unmapped device-instance share, chips missing key metadata, unverified license/accuracy, stale reviews —
which are surfaced by the shipped view `v_quality_warning`, not a bespoke per-warning JSON array. Every
threshold both gates read lives in `pipeline/config/quality-thresholds.json`. `dist/quality-report.json`
survives as the health-dashboard scalar summary: the **mapped-instance-share** metric (weighted by machine
count), per-machine coverage confidence, and top unmapped devices by impact.

---

## 4. Data Sources & Ingestion Strategy

| Source                                                                         | Yields                                                                                         | Method                                                                                                                                                                                                                                                                                                                                                 | Cadence                      |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| **MAME `-listxml`**                                                            | machines, chips-per-machine, clocks, driver, year, manufacturer                                | Run MAME binary in CI or parse the release's `mame -listxml` XML (~300 MB); stream-parse, keep `<chip>`, `<device_ref>`, `<machine>` attrs                                                                                                                                                                                                             | Every MAME release (monthly) |
| **MiSTer-devel GitHub org**                                                    | core list, repos, submodules (implementation discovery!)                                       | GitHub API; parse `.gitmodules` of each core to auto-discover which chip IPs it consumes                                                                                                                                                                                                                                                               | Weekly                       |
| **jotego/jtcores + jt\* repos**                                                | high-quality sound/CPU implementations + arcade cores                                          | GitHub API + curation                                                                                                                                                                                                                                                                                                                                  | Weekly                       |
| **OpenCores**                                                                  | long-tail CPU/sound implementations                                                            | Manual curation (no useful API)                                                                                                                                                                                                                                                                                                                        | As needed                    |
| **Analogue Pocket openFPGA, MiST, FPGAArcade Replay**                          | cores on other platforms                                                                       | Mix of API + curation                                                                                                                                                                                                                                                                                                                                  | Monthly                      |
| **system16.com, VGChartz-style board references**                              | platform family groupings, board photos context                                                | **Reference only, human-directed** — cite as a `source_url` on a hand-authored row; **never fetched by any tool here.** system16.com's `robots.txt` sets `ClaudeBot → Disallow: /` and `Content-Signal: ai-train=no, use=reference`, and the origin 403s non-browser clients behind a Cloudflare challenge. CI enforces the no-fetch rule (TASKS T3.8) | As needed                    |
| **MAME driver `.cpp` source, Wikidata (CC0), Wikipedia (CC-BY-SA), MRA files** | an **independent second witness** to board↔chipset, for reconciliation against MAME `-listxml` | Automated, rate-limited, cached — terms permit reuse. Emits a diff report, never writes `data/` (TASKS T3.8)                                                                                                                                                                                                                                           | Monthly                      |
| **Community PRs**                                                              | everything above, corrections                                                                  | JSON + schema validation in CI                                                                                                                                                                                                                                                                                                                         | Continuous                   |

**Key extraction detail:** MAME's XML gives each machine `<chip type="cpu" tag="maincpu" name="M68000" clock="10000000"/>` entries plus `<device_ref>` elements — that's the entire board→chip half of the join, machine-readable, for ~40k machines. The pipeline's job is filtering (parents vs. clones, exclude gambling/mechanical if desired) and normalizing names through the device map.

---

## 5. Frontend Website

> **Note (2026-07-22):** the "Data backend" and search bullets below described the chunked-JSON format PLAN
> §3.7 (old numbering) specified. [ADR 0001](docs/adr/0001-browser-database.md) replaced it with an
> in-browser SQLite engine; the bullets are rewritten to match.

### Stack

- **Angular SPA** (Angular 21+, standalone components, signals, built-in control flow), TypeScript strict mode. Purely static — no SSR, no backend; deep links handled by Azure Static Web Apps' `navigationFallback` rewrite to `index.html` (excluding the database file, per ADR 0001's consequences).
- **Data backend = in-browser SQLite** (§3.4, [ADR 0001](docs/adr/0001-browser-database.md)): the app fetches `dist/bomsquad.sqlite` once with one `fetch`, opens it in memory via `@sqlite.org/sqlite-wasm`'s `sqlite3_deserialize`, and every view/route issues SQL against it directly. No manifest, no chunk tree, no per-route network round trip after the initial load.
- Search runs as SQL against the same in-browser database (e.g. `LIKE`/`GLOB` over name and alias columns, or an FTS mechanism if query performance demands it) rather than a separately serialized, lazily-loaded index. Sizing and a possible split-database escape hatch are governed by ADR 0001's revisit trigger, not a per-chunk byte budget.
- Charts: lightweight (a small bar/treemap lib or plain SVG) for the coverage dashboard.
- Hosted on **Azure Static Web Apps**, deployed via GitHub Actions (`Azure/static-web-apps-deploy`); site redeploys whenever `site/` or `dist/bomsquad.sqlite` changes.

### Pages / views

1. **Home / dashboard** — headline stats: chips cataloged, % with implementations, machines tracked, cores tracked, top newly-viable boards.
2. **Chip browser** — filter by function taxonomy, manufacturer, implemented-status; sort by "used by N machines."
3. **Chip detail** — specs, all implementations (with license/accuracy badges), every machine that uses it, equivalence notes.
4. **Machine/board browser** — filter by kind, manufacturer, year range, platform family, coverage %, has-core.
5. **Machine detail** — full BOM table; each chip row shows implementation links or a red "missing" badge; links to MAME driver and existing cores.
6. **Platform family view** — the system16.com-style dimension: e.g., "Sega System 16B" page listing shared chipset + all machines on it + family-level coverage.
7. **🔦 The Prospector** — the flagship: core-less boards ranked by coverage, filterable by platform (MiSTer / Pocket / any), with "what's missing" inline. Shareable permalinks per board.
8. **Implementation browser** — all known HDL IP, filterable by language, license, accuracy, author.
9. **Contribute page** — how to add/fix data, linking to schema docs and issue templates.

### UX details

- Every entity gets a permalink (`/chip/ym2151`, `/machine/mame:outrun`, `/family/sega-system16b`).
- Global search box across all entity types.
- Coverage badges (e.g., `9/11 chips · 82%`) rendered consistently everywhere.
- Dark mode default (know the audience 🙂).
- **8-bit arcade-cabinet visual theme** (TASKS T7.12): pixel display face for chrome, CRT-phosphor palette,
  scanline texture on the masthead and the home hero. Applied as a token layer over the existing CSS custom properties —
  decoration on chrome, never on data. WCAG AA in both themes, and `prefers-reduced-motion` /
  `prefers-contrast: more` strip the effects entirely.

---

## 6. Execution Plan

The detailed task breakdown — with per-task agent-tier assignments, dependencies, and acceptance criteria for **ultracode** execution — lives in **[TASKS.md](TASKS.md)**.

| Phase | Theme                                  | Key output                                                  |
| ----- | -------------------------------------- | ----------------------------------------------------------- |
| 0     | Repo, CI & Azure Static Web Apps setup | Deployable skeleton from day one                            |
| 1     | Schemas, data model & quality gates    | The contract everything validates against                   |
| 2     | MAME extraction pipeline               | Deterministic `extract/*.raw.json`                          |
| 3     | Chip identity normalization            | Device map + seeded chip catalog (the real labor)           |
| 4     | Implementation catalog                 | HDL IP records with verified licenses & accuracy            |
| 5     | Core catalog                           | Cores mapped to machines across FPGA platforms              |
| 6     | Build pipeline, coverage & Prospector  | `dist/bomsquad.sqlite` (coverage is views) + quality report |
| 7     | Angular frontend                       | The browsable site; Prospector is the flagship              |
| 8     | Community workflow                     | A contribution pipeline that scales curation                |
| 9     | Launch & maintenance                   | Automated refresh + independent quality audit               |

---

## 7. MVP Definition

The smallest thing worth shipping publicly:

1. MAME extraction working for one pinned release, parents-only, arcade + console.
2. Top ~100 MAME devices mapped to ~60–80 canonical chips with metadata.
3. ~40–60 implementation records covering the canonical CPU + Yamaha/GI sound chip set.
4. MiSTer-devel core catalog ingested and machine-mapped for arcade cores.
5. Coverage computed; **Prospector page live** with at least a defensible top-25 list.
6. Chip detail + machine detail pages with working cross-links and search.
7. Deployed to Azure Static Web Apps with deep-link permalinks working and `quality-report.json` published alongside the dataset.

Everything else (equivalences, other FPGA platforms, family pages, dashboards) layers on after.

---

## 8. Risks & Open Questions

| Risk                                                                                                                                  | Mitigation                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Granularity mismatch** — MAME models custom ICs finely; FPGA IP clusters coarsely (one generic tilemap core ≈ several MAME devices) | Equivalence classes + allow implementations to claim multiple `chip_id`s; accept fuzzy coverage as advisory, not gospel     |
| **Custom silicon dominates the interesting boards** — coverage % can mislead when the 1 missing chip is the hard 20%                  | Prospector weighting penalizes missing `custom`-function chips heavily; show "what's missing" prominently                   |
| **MAME XML scale** (~300 MB, ~40k machines)                                                                                           | Stream parsing; parents-only default; commit derived JSON, not raw XML                                                      |
| **Mapping burnout** — the hand-curation is the project                                                                                | Ruthlessly prioritize by usage count; auto-generated "good first mapping" issues; celebrate contributor credits on the site |
| **License/ToS of scraped sources**                                                                                                    | GitHub API is fine; treat system16.com etc. as reference-only; document provenance per record                               |
| **Name collision check for "BOM Squad"**                                                                                              | Quick trademark/GitHub/domain search before announcing                                                                      |
| **Closed-source cores** (some Patreon-era cores lack public HDL)                                                                      | `open_source: false` flag; they still count as "core exists" for Prospector purposes                                        |
| Console BOMs in MAME are sometimes abstracted (e.g., chips folded into one device)                                                    | Overlay files per machine; consoles are few enough to hand-verify                                                           |

---

## 9. Suggested Repo Layout

> **Note (2026-07-22):** `schemas/` and `data/` below predate the relational rewrite. `schemas/` now holds
> `schema.sql` (normative DDL) plus one JSON Schema per table (`schemas/README.md`); `data/`'s subdirectories
> are Phase 0 scaffolding that has not yet been reorganized around the table set in `docs/data-model.md` §1.9
> (no schema change makes `cores/`, `mappings/equivalences.json`, or `overlays/` load-bearing concepts
> anymore — see §3.1). `dist/site-data/` is deleted per §3.4; the build's one artifact is
> `dist/bomsquad.sqlite`.

```
bom-squad/
├─ README.md
├─ LICENSE-CODE (MIT)  /  LICENSE-DATA (CC-BY-SA-4.0)
├─ schemas/            # schema.sql (normative DDL) + one JSON Schema per table
├─ data/                # curated row files, one JSON file per row, grouped by table
├─ extract/            # generated: machines.raw.json, mame-devices.raw.json
├─ pipeline/           # extraction, load, coverage, validation (TypeScript, Node 24)
├─ dist/               # build outputs (published via Releases)
│  └─ bomsquad.sqlite  # the primary artifact — the site queries it directly (§3.4)
├─ site/               # Angular SPA + staticwebapp.config.json (Azure Static Web Apps)
└─ docs/               # data-model.md, taxonomy.md, coverage.md, data-quality.md, adr/
```
