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
   ├─ implementations/*.json│   BUILD PIPELINE    │
   ├─ cores/*.json          │  (normalize, join,  │──► dist/bomsquad.json
   ├─ mappings/             │  validate, derive)  │──► dist/bomsquad.sqlite
   │   mame-device-map.json └─────────────────────┘──► dist/coverage.json
   └─ overlays/*.json                 │
                                      ▼
                          ┌─────────────────────────┐
                          │  site/ (static frontend)│
                          │  GitHub Pages           │
                          └─────────────────────────┘
```

- **`data/`** — curated JSON, the heart of the project, PR-reviewed.
- **`extract/`** — deterministic outputs of the MAME parser (and other scrapers), committed for diff-ability or rebuilt in CI.
- **`dist/`** — the single normalized dataset the site (and any third party) consumes. Published as a versioned release artifact.
- **`site/`** — static frontend, deployed on GitHub Pages / Cloudflare Pages.

---

## 3. Data Model

### 3.1 `chips` (curated + MAME-seeded)
```jsonc
{
  "id": "ym2151",                    // stable slug
  "names": ["YM2151", "OPM"],
  "manufacturer": "Yamaha",
  "model": "YM2151",
  "family": "OPM",
  "function": "sound.fm",            // taxonomy: cpu, sound.fm, sound.psg, sound.pcm,
                                     // video.tilemap, video.sprite, video.ppu, io, custom, glue
  "description": "8-channel, 4-operator FM sound synthesis chip",
  "typical_clock_hz": 3579545,
  "package": "DIP-24",
  "year_introduced": 1984,
  "mame_devices": ["ym2151"],        // join key(s) to MAME's device names
  "datasheet_urls": ["..."],
  "notes": "..."
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
  "accuracy": "cycle-approximate",   // enum: gate-level, cycle-accurate,
                                     // cycle-approximate, behavioral, partial
  "verified_against_hardware": true,
  "target_platforms": ["mister", "pocket", "mist", "generic"],
  "known_consumers": ["core:mister-arcade-cps1", "core:mister-x68000"],
  "resource_notes": "≈3k LEs on Cyclone V",
  "last_reviewed": "2026-07-01",
  "notes": "De-facto standard OPM implementation in the retro FPGA scene"
}
```

### 3.3 `machines` (generated from MAME, enriched via overlays)
```jsonc
{
  "id": "mame:outrun",
  "name": "Out Run",
  "kind": "arcade",                  // arcade | console | computer | handheld
  "manufacturer": "Sega",
  "year": 1986,
  "platform_family": "sega-outrun-hw", // curated grouping ≈ system16.com's boards
  "source": { "type": "mame", "mame_version": "0.278", "driver": "outrun.cpp" },
  "chips": [
    { "chip_id": "m68000", "role": "maincpu", "clock_hz": 10000000, "count": 2 },
    { "chip_id": "z80",    "role": "audiocpu", "clock_hz": 4000000 },
    { "chip_id": "ym2151", "role": "sound", "clock_hz": 4000000 },
    { "chip_id": "sega-pcm", "role": "sound" },
    { "chip_id": "unknown:sega-315-5197", "role": "custom" }  // unmapped custom silicon
  ]
}
```

### 3.4 `cores` (curated + scraped)
```jsonc
{
  "id": "core:mister-arcade-outrun",
  "name": "Arcade: Out Run",
  "platform": "mister",              // mister | mist | pocket | replay | neptuno | other
  "repo": "https://github.com/MiSTer-devel/Arcade-OutRun_MiSTer",
  "open_source": true,
  "machines": ["mame:outrun", "mame:outruneh"],
  "platform_families": ["sega-outrun-hw"]
}
```

### 3.5 Mapping & overlay files (curated — where human judgment lives)
- `mappings/mame-device-map.json` — MAME device name → canonical `chip_id` (e.g. `"m68000" → "m68000"`, `"ym3438" → "ym3438"`, `"sega_315_5124" → "sega-vdp-315-5124"`). Unmapped devices flow through as `unknown:*` so nothing is silently dropped.
- `mappings/platform-families.json` — machine → board family grouping (the system16.com dimension MAME lacks as first-class data).
- `overlays/machines/*.json` — hand corrections/additions to generated machine data (e.g., chips MAME abstracts away, discrete-logic notes, machines not in MAME).
- `mappings/equivalences.json` — chip equivalence classes (YM3438 ≈ YM2612 die-shrink; a 68010 implementation *can* satisfy a 68000 socket, etc.) used optionally in coverage math.

### 3.6 Derived data (build outputs, never hand-edited)
- `coverage.json` — per machine: total mapped chips, implemented count, coverage %, missing chip list, has-core flags per FPGA platform.
- Reverse indexes: chip → machines using it; chip → implementations; implementation → consumers.
- **Prospector ranking** — machines with no core on platform X, sorted by coverage desc, weighted so a missing *custom* chip penalizes more than a missing jellybean.

---

## 4. Data Sources & Ingestion Strategy

| Source | Yields | Method | Cadence |
|---|---|---|---|
| **MAME `-listxml`** | machines, chips-per-machine, clocks, driver, year, manufacturer | Run MAME binary in CI or parse the release's `mame -listxml` XML (~300 MB); stream-parse, keep `<chip>`, `<device_ref>`, `<machine>` attrs | Every MAME release (monthly) |
| **MiSTer-devel GitHub org** | core list, repos, submodules (implementation discovery!) | GitHub API; parse `.gitmodules` of each core to auto-discover which chip IPs it consumes | Weekly |
| **jotego/jtcores + jt\* repos** | high-quality sound/CPU implementations + arcade cores | GitHub API + curation | Weekly |
| **OpenCores** | long-tail CPU/sound implementations | Manual curation (no useful API) | As needed |
| **Analogue Pocket openFPGA, MiST, FPGAArcade Replay** | cores on other platforms | Mix of API + curation | Monthly |
| **system16.com, VGChartz-style board references** | platform family groupings, board photos context | **Reference only** — inform curation by hand; do not scrape (respect their content) | As needed |
| **Community PRs** | everything above, corrections | JSON + schema validation in CI | Continuous |

**Key extraction detail:** MAME's XML gives each machine `<chip type="cpu" tag="maincpu" name="M68000" clock="10000000"/>` entries plus `<device_ref>` elements — that's the entire board→chip half of the join, machine-readable, for ~40k machines. The pipeline's job is filtering (parents vs. clones, exclude gambling/mechanical if desired) and normalizing names through the device map.

---

## 5. Frontend Website

### Stack
- **Static site**, no backend: Vite + React (or Astro with a React island for the explorer), TypeScript.
- Client-side search via **MiniSearch** or **fuse.js** over `dist/bomsquad.json`; if the dataset outgrows comfortable in-browser JSON (>15–20 MB), switch to **sql.js/SQLite-over-HTTP with range requests** — the schema is already shipped as SQLite.
- Charts: lightweight (e.g., a bar/treemap lib) for the coverage dashboard.
- Hosted on **GitHub Pages** via Actions; site rebuilds whenever `dist/` changes.

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

## 6. Task List

### Phase 0 — Project setup
- [ ] Create GitHub org/repo `bom-squad` (check name availability for org + domain, e.g. `bomsquad.dev`)
- [ ] Choose licenses: code (MIT) and data (CC-BY-SA 4.0 vs CC0 — decide and document)
- [ ] Repo scaffolding: `data/`, `extract/`, `pipeline/`, `site/`, `schemas/`, `docs/`
- [ ] Write README with vision, architecture diagram, and the Prospector pitch
- [ ] Set up CI skeleton (GitHub Actions): lint, schema validation, build

### Phase 1 — Schemas & data model
- [ ] Author JSON Schema files for `chip`, `implementation`, `machine`, `core`, `mapping`, `overlay`
- [ ] Define the chip `function` taxonomy (enumerate and document it)
- [ ] Define ID/slug conventions and document stability guarantees
- [ ] Define the equivalence-class model and how it affects coverage math
- [ ] Write `docs/data-model.md` with examples
- [ ] CI job: validate every file in `data/` against schemas on each PR

### Phase 2 — MAME extraction pipeline
- [ ] Script: download/run MAME `-listxml` for a pinned release version
- [ ] Stream-parse XML → `extract/machines.raw.json` (machines, chips, clocks, year, manufacturer, driver, parent/clone)
- [ ] Filtering rules: parents-only by default (clones inherit), exclude non-electronic/mechanical/gambling categories (configurable)
- [ ] Emit `extract/mame-devices.raw.json`: every distinct device name + usage count (this is the worklist for mapping)
- [ ] Determinism check: re-running on same MAME version produces byte-identical output
- [ ] CI job: monthly workflow that pulls the newest MAME release, regenerates extracts, opens an automated PR with the diff

### Phase 3 — Chip identity normalization (the real labor)
- [ ] Seed `mappings/mame-device-map.json` for the top ~100 devices by machine count (this alone covers a huge share of boards)
- [ ] Establish `unknown:*` passthrough convention for unmapped devices
- [ ] Seed `data/chips/` entries for all mapped chips (metadata: manufacturer, function, clocks, description)
- [ ] Curate `mappings/platform-families.json` for the major arcade platforms (System 1/16/24, CPS-1/2, Neo Geo MVS, Taito F2/F3, Konami GX etc.) and consoles
- [ ] Curate `mappings/equivalences.json` for the well-known equivalence pairs
- [ ] Document the mapping-contribution workflow (how a contributor claims and maps a device)

### Phase 4 — Implementation catalog seeding
- [ ] Ingest jotego jt\* family (JT51, JT12, JTOPL, JT49, JT89, JT5205, JTFRAME CPUs…)
- [ ] Ingest the canonical CPU cores: T80, TV80, fx68k, TG68K.C, ao68000, T65, verilog-6502, MicroCore Labs set, ao486
- [ ] Auto-discovery script: walk MiSTer-devel core repos' `.gitmodules` + `rtl/` folders to find reused IP; emit candidate implementation records for human review
- [ ] Curate accuracy/license/platform metadata per implementation
- [ ] `known_consumers` back-links populated from the auto-discovery pass
- [ ] Link-checker CI job (repos move; catch dead links monthly)

### Phase 5 — Core catalog ingestion
- [ ] Script: enumerate MiSTer-devel org repos via GitHub API → `cores` records (name, repo, arcade vs console classification)
- [ ] Map each core → machine(s) (start with arcade cores whose names match MAME shortnames; hand-map the rest)
- [ ] Add unofficial/other-platform cores: jotego JTBIN targets, Analogue Pocket openFPGA cores, MiST, FPGAArcade Replay
- [ ] Record open/closed-source status per core

### Phase 6 — Build pipeline & coverage engine
- [ ] Normalizer: join extracts + curated data + overlays → `dist/bomsquad.json` (+ SQLite export)
- [ ] Coverage computation per machine and per platform family, honoring equivalence classes
- [ ] Prospector ranking algorithm (weighting: custom silicon missing ≫ commodity chip missing; bonus for family-mates already cored)
- [ ] Build-time integrity checks: dangling IDs, orphaned implementations, duplicate slugs
- [ ] Publish `dist/` as versioned GitHub Release artifacts on each merge to main
- [ ] Write `docs/consuming-the-dataset.md` for third parties

### Phase 7 — Frontend website
- [ ] Scaffold site (Vite + React + TS), load `dist/bomsquad.json`, set up client-side routing with permalinks
- [ ] Global search (MiniSearch index over chips/machines/implementations/cores)
- [ ] Chip browser + chip detail pages
- [ ] Machine browser + machine detail (BOM table with implementation links / missing badges)
- [ ] Platform family pages
- [ ] **The Prospector view** (the launch feature — polish this most)
- [ ] Implementation browser
- [ ] Dashboard/home with headline stats
- [ ] Responsive layout + dark mode
- [ ] Deploy to GitHub Pages via Actions; wire custom domain if acquired

### Phase 8 — Community & contribution workflow
- [ ] `CONTRIBUTING.md`: how to add a chip, an implementation, a mapping, an overlay
- [ ] PR templates + issue templates ("Add implementation", "Map MAME device", "Correct BOM")
- [ ] Schema validation + link check as required PR status checks
- [ ] "Good first mapping" issue generator: auto-open issues for high-usage unmapped MAME devices
- [ ] Announce/collect feedback: MiSTer FPGA forum thread, retro FPGA Discords, r/fpgagaming

### Phase 9 — Launch & maintenance
- [ ] MVP launch checklist (see below)
- [ ] Automate: monthly MAME refresh PR, weekly GitHub scrape refresh, monthly link check
- [ ] Dataset versioning policy (semver on schema; date-tag on data releases)
- [ ] Roadmap candidates: FPGA resource-usage benchmarking, per-implementation quality reports, discrete-logic (74xx) modeling, Analogue Pocket coverage parity view, "adopt a board" pledges

---

## 7. MVP Definition

The smallest thing worth shipping publicly:

1. MAME extraction working for one pinned release, parents-only, arcade + console.
2. Top ~100 MAME devices mapped to ~60–80 canonical chips with metadata.
3. ~40–60 implementation records covering the canonical CPU + Yamaha/GI sound chip set.
4. MiSTer-devel core catalog ingested and machine-mapped for arcade cores.
5. Coverage computed; **Prospector page live** with at least a defensible top-25 list.
6. Chip detail + machine detail pages with working cross-links and search.

Everything else (equivalences, other FPGA platforms, family pages, dashboards) layers on after.

---

## 8. Risks & Open Questions

| Risk | Mitigation |
|---|---|
| **Granularity mismatch** — MAME models custom ICs finely; FPGA IP clusters coarsely (one generic tilemap core ≈ several MAME devices) | Equivalence classes + allow implementations to claim multiple `chip_id`s; accept fuzzy coverage as advisory, not gospel |
| **Custom silicon dominates the interesting boards** — coverage % can mislead when the 1 missing chip is the hard 20% | Prospector weighting penalizes missing `custom`-function chips heavily; show "what's missing" prominently |
| **MAME XML scale** (~300 MB, ~40k machines) | Stream parsing; parents-only default; commit derived JSON, not raw XML |
| **Mapping burnout** — the hand-curation is the project | Ruthlessly prioritize by usage count; auto-generated "good first mapping" issues; celebrate contributor credits on the site |
| **License/ToS of scraped sources** | GitHub API is fine; treat system16.com etc. as reference-only; document provenance per record |
| **Name collision check for "BOM Squad"** | Quick trademark/GitHub/domain search before announcing |
| **Closed-source cores** (some Patreon-era cores lack public HDL) | `open_source: false` flag; they still count as "core exists" for Prospector purposes |
| Console BOMs in MAME are sometimes abstracted (e.g., chips folded into one device) | Overlay files per machine; consoles are few enough to hand-verify |

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
├─ pipeline/           # extraction, normalization, coverage, validation (Python or TS)
├─ dist/               # build outputs (or published via Releases only)
├─ site/               # static frontend
└─ docs/               # data-model.md, contributing guides, consuming-the-dataset.md
```
