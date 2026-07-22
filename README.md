# BOM Squad

An open database mapping arcade boards and consoles to their chip bills-of-materials, mapping those chips to existing open-source FPGA implementations, and surfacing boards that are ready to become cores but don't have one yet.

## The Prospector

The flagship feature is **the Prospector**: a ranked list of core-less boards, sorted by how much of their chip BOM already has open-source FPGA implementations.

FPGA core development for retro arcade hardware is bottlenecked by two things: knowing which boards _don't_ already have a core, and knowing which of those are actually tractable — i.e., most of their chips are already implemented in HDL somewhere, and only a handful of gaps stand between "no core" and "playable core." Right now that's tribal knowledge, scattered across forum threads and the memory of a few prolific core authors.

The Prospector turns it into a query: for every board without a core on a given FPGA platform, compute `implemented chips / total chips` from the chip catalog and implementation index, weight it so a missing custom chip counts for more than a missing 74-series jellybean, and rank the result. A core developer looking for their next project can open the Prospector, see the top candidates, and know exactly which chips are already solved and which ones are the actual work — before writing a line of HDL.

## Architecture

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
- **`dist/`** — build outputs: the chunked site JSON (`site-data/`), a SQLite export for third parties, and the data quality report. Published as versioned release artifacts.
- **`site/`** — Angular SPA, deployed to Azure Static Web Apps.

See [PLAN.md](PLAN.md) for the full design (data model, ingestion strategy, site pages, execution plan).

## How it works

Two kinds of data live in this repo, and they're never mixed:

- **Curated (`data/`)** — hand-authored, PR-reviewed JSON: chip specs, implementation records, core catalogs, and the mapping/overlay files that encode human judgment (MAME device → canonical chip, board → platform family, chip equivalences). This is what contributors edit.
- **Generated (`extract/`, `dist/`)** — machine output. `extract/` is the deterministic result of parsing MAME's `-listxml` dump. `dist/` is the build pipeline's output: normalized data, coverage numbers, the chunked JSON the site fetches, and the quality report. Same inputs always produce byte-identical output.

Generated data is **never hand-edited**. If MAME extraction gets a chip wrong, or abstracts several chips into one device, the fix goes in `data/overlays/` (a correction layered on top at build time) or `data/mappings/mame-device-map.json` (a correction to how a device name resolves to a chip), not in `extract/` itself. That way corrections survive every re-run of the extractor against a new MAME release — the alternative, hand-patching generated files, would silently get clobbered the next time the pipeline runs.

## Quick start

Requires Node 24 (see `.nvmrc`; run `nvm use` if you have nvm installed) and npm 11.

```sh
git clone https://github.com/mcfbytes/BomSquad.git
cd BomSquad
npm install
npm run build
npm start --workspace @bomsquad/site
```

The site serves at **http://localhost:4200**.

`npm run build` builds every workspace (currently `pipeline` and `site`). Other useful root scripts: `npm run lint`, `npm run typecheck`, `npm test`, and `npm run validate` (runs the pipeline's data validator against everything in `data/`).

## Project status

**Phase 0, pre-MVP.** The repo skeleton, CI, and Angular shell exist; the data pipeline, chip catalog, and site views are not yet built.

- See [PLAN.md §7](PLAN.md#7-mvp-definition) for what "MVP" means here.
- See [TASKS.md](TASKS.md) for the full task breakdown and current execution plan.

## Licensing

This repo splits code and data under different licenses:

- **Code** (`pipeline/`, `site/`, scripts, config) is **MIT** — see [LICENSE-CODE](LICENSE-CODE).
- **Data** (`data/`, `extract/`, `dist/`) is **[CC-BY-SA-4.0](https://creativecommons.org/licenses/by-sa/4.0/)** — see [LICENSE-DATA](LICENSE-DATA).

The split is deliberate: the pipeline and site source is permissive so anyone can build on or fork the tooling freely. The curated dataset is share-alike so that improvements — corrected chip metadata, new implementation records, better mappings — flow back to the community instead of being absorbed into a closed fork.

Every curated fact needs a paper trail: cite the source in the record's `notes` field or in the commit message that introduces it. Unknown fields are omitted, never guessed — an absent value is honest, a wrong one poisons the dataset.

## More

- [`docs/`](docs/) — data model, taxonomy, and consumer-facing documentation (growing alongside the pipeline).
- `CONTRIBUTING.md` — coming in Phase 8; until then, see [TASKS.md](TASKS.md) for how the project is organized.
- [Issue tracker](https://github.com/mcfbytes/BomSquad/issues)
