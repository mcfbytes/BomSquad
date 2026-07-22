# extract

Machine-generated, deterministic output of the MAME XML parser and other scrapers. Two key files:

1. `machines.raw.json` — every MAME machine from the pinned release (filtered: parents-only by default, excludes devices/mechanical/gambling). Unmodified raw-machine records.
2. `mame-devices.raw.json` — every distinct device/chip name with instance + machine counts, sorted by impact. The curation worklist for Phase 3.

Never hand-edit these files. Corrections go in `data/mappings/`, `data/overlays/`, or `data/chips/`. Re-extraction on every MAME release preserves your curation.

**Edit policy:** GENERATED. Never hand-edit. Produced by the pipeline's MAME extraction stage (Phase 2) and rebuilt on every MAME release. Committed to Git for diff-ability in pull requests.
