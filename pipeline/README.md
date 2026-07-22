# pipeline

TypeScript / Node.js workspace (Node 24). The extraction, normalization, and validation engine:

- **extract** — MAME XML parser (stream-based, < 1 GB RSS), device worklist generator.
- **validate** — JSON Schema enforcement over `data/` and generated outputs.
- **normalize/join** — merge `extract/` + `data/` + overlays into the canonical model.
- **coverage** — per-machine and per-family implementation coverage computation.
- **prospector** — rank core-less boards by viability.
- **emit** — chunked `dist/site-data/` JSON + SQLite export.

All pipeline stages are deterministic: same inputs produce byte-identical outputs, verified in CI.

**Edit policy:** CODE. TypeScript source, reviewed via PR. Keep tests comprehensive; any data transformation must be justified by a test. Determinism is non-negotiable.
