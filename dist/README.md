# dist

Build outputs: never hand-edited, never committed (except `.gitkeep`). Produced by
`npm run build:db --workspace @bomsquad/pipeline` (equivalently, `pipeline build`).

Note that the root `npm run build` is **not** this command — it runs `tsc` in each workspace and produces no
database. The dataset has its own command because it is a different kind of artifact with different inputs.

- **bomsquad.sqlite** — the dataset. One SQLite database built from the curated row files in `data/` plus the generated `extract/`, carrying every table and view in [`schemas/schema.sql`](../schemas/schema.sql). It is both the third-party export and what the site itself queries in the browser; there is no separate chunked-JSON format (see [`docs/adr/0001-browser-database.md`](../docs/adr/0001-browser-database.md)).
- **quality-report.json** — build-time data quality metrics, per [`docs/data-quality.md`](../docs/data-quality.md).
Not built yet: a versioned distribution archive published to GitHub Releases (TASKS T6.6). Nothing in
`pipeline/` or `.github/workflows/` produces one today, so the two files above are the whole of `dist/`.

**Edit policy:** BUILD OUTPUT. Never hand-edit. Regenerated on every build. Determinism is enforced: CI fails if double-building produces different outputs.
