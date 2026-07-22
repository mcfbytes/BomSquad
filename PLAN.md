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

```
                          ┌─────────────────────────┐
   MAME -listxml ────────►│  extract/ (generated)   │
   (per-release dump)     │  machines.raw.json      │
                          └───────────┬─────────────┘
                                      │
   data/ (curated, in Git)            ▼
   ├─ chips/*.json          ┌─────────────────────┐
   ├─ implementations/*.json│   BUILD PIPELINE    │──► dist/site-data/ (chunked
   ├─ cores/*.json          │  (normalize, join,  │      JSON the site consumes)
   ├─ mappings/             │  validate, derive)  │──► dist/bomsquad.sqlite
   │   mame-device-map.json └─────────────────────┘──► dist/quality-report.json
   └─ overlays/*.json                 │
                                      ▼
                          ┌─────────────────────────┐
                          │  site/ (Angular SPA)    │
                          │  Azure Static Web Apps  │
                          └─────────────────────────┘
```

- **`data/`** — curated JSON, the heart of the project, PR-reviewed.
- **`extract/`** — deterministic outputs of the MAME parser (and other scrapers), committed for diff-ability or rebuilt in CI.
- **`dist/`** — build outputs: the chunked site JSON (`site-data/`, §3.7), a SQLite export for third parties, and the data quality report (§3.8). Published as versioned release artifacts.
- **`site/`** — Angular SPA, deployed to Azure Static Web Apps.

---

## 3. Data Model

### 3.1 `chips` (curated + MAME-seeded)

```jsonc
{
  "id": "ym2151", // stable slug
  "names": ["YM2151", "OPM"],
  "manufacturer": "Yamaha",
  "model": "YM2151",
  "family": "OPM",
  "function": "sound.fm", // taxonomy: cpu, sound.fm, sound.psg, sound.pcm,
  // video.tilemap, video.sprite, video.ppu, io, custom, glue
  "description": "8-channel, 4-operator FM sound synthesis chip",
  "typical_clock_hz": 3579545,
  "package": "DIP-24",
  "year_introduced": 1984,
  "mame_devices": ["ym2151"], // join key(s) to MAME's device names
  "datasheet_urls": ["..."],
  "notes": "...",
}
```

### 3.2 `implementations` (curated)

```jsonc
{
  "id": "jt51",
  "chip_id": "ym2151",
  "name": "JT51",
  "repo": "https://github.com/jotego/jt51",
  "paths": ["hdl/jt51.v"],
  "language": "verilog",
  "license": "GPL-3.0",
  "author": "Jose Tejada (jotego)",
  "accuracy": "cycle-approximate", // enum: gate-level, cycle-accurate,
  // cycle-approximate, behavioral, partial
  "verified_against_hardware": true,
  "target_platforms": ["mister", "pocket", "mist", "generic"],
  "known_consumers": ["core:mister-arcade-cps1", "core:mister-x68000"],
  "resource_notes": "≈3k LEs on Cyclone V",
  "last_reviewed": "2026-07-01",
  "notes": "De-facto standard OPM implementation in the retro FPGA scene",
}
```

### 3.3 `machines` (generated from MAME, enriched via overlays)

```jsonc
{
  "id": "mame:outrun",
  "name": "Out Run",
  "kind": "arcade", // arcade | console | computer | handheld
  "manufacturer": "Sega",
  "year": 1986,
  "platform_family": "sega-outrun-hw", // curated grouping ≈ system16.com's boards
  "source": { "type": "mame", "mame_version": "0.278", "driver": "outrun.cpp" },
  "chips": [
    { "chip_id": "m68000", "role": "maincpu", "clock_hz": 10000000, "count": 2 },
    { "chip_id": "z80", "role": "audiocpu", "clock_hz": 4000000 },
    { "chip_id": "ym2151", "role": "sound", "clock_hz": 4000000 },
    { "chip_id": "sega-pcm", "role": "sound" },
    { "chip_id": "unknown:sega-315-5197", "role": "custom" }, // unmapped custom silicon
  ],
}
```

### 3.4 `cores` (curated + scraped)

```jsonc
{
  "id": "core:mister-arcade-outrun",
  "name": "Arcade: Out Run",
  "platform": "mister", // mister | mist | pocket | replay | neptuno | other
  "repo": "https://github.com/MiSTer-devel/Arcade-OutRun_MiSTer",
  "open_source": true,
  "machines": ["mame:outrun", "mame:outruneh"],
  "platform_families": ["sega-outrun-hw"],
}
```

### 3.5 Mapping & overlay files (curated — where human judgment lives)

- `mappings/mame-device-map.json` — MAME device name → canonical `chip_id` (e.g. `"m68000" → "m68000"`, `"ym3438" → "ym3438"`, `"sega_315_5124" → "sega-vdp-315-5124"`). Unmapped devices flow through as `unknown:*` so nothing is silently dropped.
- `mappings/platform-families.json` — machine → board family grouping (the system16.com dimension MAME lacks as first-class data).
- `overlays/machines/*.json` — hand corrections/additions to generated machine data (e.g., chips MAME abstracts away, discrete-logic notes, machines not in MAME).
- `mappings/equivalences.json` — chip equivalence classes (YM3438 ≈ YM2612 die-shrink; a 68010 implementation _can_ satisfy a 68000 socket, etc.) used optionally in coverage math.

### 3.6 Derived data (build outputs, never hand-edited)

- Coverage, per machine and per platform family: total mapped chips, implemented count, coverage %, missing chip list (with a per-chip reason: no implementation / unknown chip / unmapped device), confidence level (degraded when `unknown:*` chips are present), has-core flags per FPGA platform. Embedded in the machine/family records and Prospector chunks (§3.7).
- Reverse indexes: chip → machines using it; chip → implementations; implementation → consumers.
- **Prospector ranking** — machines with no core on platform X, sorted by coverage desc, weighted so a missing _custom_ chip penalizes more than a missing jellybean.

### 3.7 Site data publishing format (chunked JSON)

The site never downloads one monolithic file. The build emits `dist/site-data/` as a static "API". The table lists **logical names**; physical chunk files are written under content-hashed filenames, and `manifest.json` maps logical name → hashed path.

| Logical file                                | Contents                                                                                                         |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `manifest.json`                             | dataset version, MAME version, build date, entity counts, logical-name → content-hashed-path map for every chunk |
| `stats.json`                                | headline numbers for the dashboard                                                                               |
| `chips/index.json`                          | chip summaries for the browser (id, names, function, manufacturer, machine count, implementation count)          |
| `chips/{id}.json`                           | full chip detail: specs, implementations, machines using it, equivalences                                        |
| `machines/index-{nn}.json`                  | machine summaries, sharded (~1,000 per chunk)                                                                    |
| `machines/detail/{xx}.json`                 | full machine records incl. BOM + coverage, bucketed by 2-hex-char hash of id (~256 files)                        |
| `families/index.json`, `families/{id}.json` | platform family pages                                                                                            |
| `implementations/index.json`                | all implementation records (small enough for one file)                                                           |
| `cores/index.json`                          | all core records                                                                                                 |
| `prospector/{platform}.json`                | precomputed rankings (mister, pocket, any…) with score breakdowns and what's-missing inline                      |
| `search/{n}.json`                           | serialized search-index chunks, loaded on first search interaction                                               |
| `quality-report.json`                       | build-time data quality metrics (§3.8)                                                                           |

Rules:

- Every chunk ≤ **250 KB gzipped**; the emitter fails the build (and re-shards) if exceeded.
- Content-hashed filenames + immutable cache headers for all chunks; only `manifest.json` is short-TTL. Cache busting is free and atomic.
- The emitter is **deterministic**: same inputs → byte-identical output tree.

### 3.8 Data quality gates (build-enforced)

Quality is a build artifact, not an aspiration. Every build:

- **Fails** on: schema violations; duplicate or malformed slugs; dangling cross-references (machine→chip, implementation→chip, core→machine, equivalence→chip, family→machine); chunk-size budget violations; non-deterministic output (double-build byte-compare in CI).
- **Warns** (tracked in `quality-report.json`) on: unmapped device-instance share above threshold; chips missing key metadata (function, manufacturer); implementations with unverified license or accuracy; machines with zero mapped chips; stale `last_reviewed` dates.

`quality-report.json` is the project's health dashboard: **% of chip instances mapped or explicitly ignored** (weighted by machine count — the single most important curation metric), per-machine coverage confidence, and top unmapped devices by impact (which feeds the "good first mapping" issue generator).

---

## 4. Data Sources & Ingestion Strategy

| Source                                                | Yields                                                          | Method                                                                                                                                     | Cadence                      |
| ----------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| **MAME `-listxml`**                                   | machines, chips-per-machine, clocks, driver, year, manufacturer | Run MAME binary in CI or parse the release's `mame -listxml` XML (~300 MB); stream-parse, keep `<chip>`, `<device_ref>`, `<machine>` attrs | Every MAME release (monthly) |
| **MiSTer-devel GitHub org**                           | core list, repos, submodules (implementation discovery!)        | GitHub API; parse `.gitmodules` of each core to auto-discover which chip IPs it consumes                                                   | Weekly                       |
| **jotego/jtcores + jt\* repos**                       | high-quality sound/CPU implementations + arcade cores           | GitHub API + curation                                                                                                                      | Weekly                       |
| **OpenCores**                                         | long-tail CPU/sound implementations                             | Manual curation (no useful API)                                                                                                            | As needed                    |
| **Analogue Pocket openFPGA, MiST, FPGAArcade Replay** | cores on other platforms                                        | Mix of API + curation                                                                                                                      | Monthly                      |
| **system16.com, VGChartz-style board references**     | platform family groupings, board photos context                 | **Reference only** — inform curation by hand; do not scrape (respect their content)                                                        | As needed                    |
| **Community PRs**                                     | everything above, corrections                                   | JSON + schema validation in CI                                                                                                             | Continuous                   |

**Key extraction detail:** MAME's XML gives each machine `<chip type="cpu" tag="maincpu" name="M68000" clock="10000000"/>` entries plus `<device_ref>` elements — that's the entire board→chip half of the join, machine-readable, for ~40k machines. The pipeline's job is filtering (parents vs. clones, exclude gambling/mechanical if desired) and normalizing names through the device map.

---

## 5. Frontend Website

### Stack

- **Angular SPA** (Angular 21+, standalone components, signals, built-in control flow), TypeScript strict mode. Purely static — no SSR, no backend; deep links handled by Azure Static Web Apps' `navigationFallback` rewrite to `index.html` (excluding `/site-data/*`).
- **Data backend = chunked JSON** (§3.7): the app fetches `manifest.json` at boot, then lazily loads index and detail chunks per route. No monolithic dataset download; every chunk stays small enough to feel instant.
- Client-side search over prebuilt, lazily-loaded search-index chunks (MiniSearch-serialized); if the dataset ever outgrows this, the SQLite export enables sql.js-over-HTTP with range requests as an escape hatch.
- Charts: lightweight (a small bar/treemap lib or plain SVG) for the coverage dashboard.
- Hosted on **Azure Static Web Apps**, deployed via GitHub Actions (`Azure/static-web-apps-deploy`); site redeploys whenever `site/` or `dist/site-data/` changes.

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

---

## 6. Execution Plan

The detailed task breakdown — with per-task agent-tier assignments, dependencies, and acceptance criteria for **ultracode** execution — lives in **[TASKS.md](TASKS.md)**.

| Phase | Theme                                  | Key output                                        |
| ----- | -------------------------------------- | ------------------------------------------------- |
| 0     | Repo, CI & Azure Static Web Apps setup | Deployable skeleton from day one                  |
| 1     | Schemas, data model & quality gates    | The contract everything validates against         |
| 2     | MAME extraction pipeline               | Deterministic `extract/*.raw.json`                |
| 3     | Chip identity normalization            | Device map + seeded chip catalog (the real labor) |
| 4     | Implementation catalog                 | HDL IP records with verified licenses & accuracy  |
| 5     | Core catalog                           | Cores mapped to machines across FPGA platforms    |
| 6     | Build pipeline, coverage & Prospector  | `dist/site-data/` chunked JSON + quality report   |
| 7     | Angular frontend                       | The browsable site; Prospector is the flagship    |
| 8     | Community workflow                     | A contribution pipeline that scales curation      |
| 9     | Launch & maintenance                   | Automated refresh + independent quality audit     |

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

```
bom-squad/
├─ README.md
├─ LICENSE-CODE (MIT)  /  LICENSE-DATA (CC-BY-SA-4.0)
├─ schemas/            # JSON Schema per entity
├─ data/
│  ├─ chips/           # one file per chip
│  ├─ implementations/ # one file per implementation
│  ├─ cores/           # one file per core platform (mister.json, pocket.json…)
│  ├─ mappings/        # mame-device-map, platform-families, equivalences
│  └─ overlays/        # hand corrections to generated machine data
├─ extract/            # generated: machines.raw.json, mame-devices.raw.json
├─ pipeline/           # extraction, normalization, coverage, validation (TypeScript, Node 22)
├─ dist/               # build outputs (published via Releases)
│  └─ site-data/       # chunked JSON the site consumes (§3.7)
├─ site/               # Angular SPA + staticwebapp.config.json (Azure Static Web Apps)
└─ docs/               # data-model.md, contributing guides, consuming-the-dataset.md
```
