# docs

Prose documentation for BOM Squad's relational data model. The current doc set:

| Doc                                  | Owns                                                                                                                                                                                                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`data-model.md`](data-model.md)     | The schema itself — every table, column, key, index and view in `schemas/schema.sql` (Appendix A tables, Appendix B views). Normative for structure; where any other doc disagrees on structure, this one wins.                                      |
| [`taxonomy.md`](taxonomy.md)         | The `chip_function` lookup table: its rows, `prospector_band` values, and the decision guide a curator follows to classify a chip. Normative for `data/lookup/chip_function.json`.                                                                   |
| [`coverage.md`](coverage.md)         | Chip equivalence (`chip_equivalence`) and coverage semantics — the four `CREATE VIEW` statements that answer "does an implementation exist for this socket." Normative for equivalence/coverage semantics; supersedes the deleted `equivalences.md`. |
| [`data-quality.md`](data-quality.md) | The quality model: FAIL/WARN conditions, warning codes, the `v_quality_warning`/`v_quality_instance` views, and every threshold in `pipeline/config/quality-thresholds.json`. Normative for quality semantics.                                       |
| [`adr/`](adr/)                       | Architecture decision records. [`0001-browser-database.md`](adr/0001-browser-database.md) covers how the SPA queries `dist/bomsquad.sqlite` client-side.                                                                                             |
| [`azure-setup.md`](azure-setup.md)   | Runbook for provisioning and operating the Azure Static Web App that hosts the site.                                                                                                                                                                 |

See [PLAN.md](../PLAN.md) for the project vision and [TASKS.md](../TASKS.md) for the execution plan.

**Edit policy:** CURATED. Hand-edited via PR. `data-model.md`, `coverage.md`, and `data-quality.md` are
cross-referenced and state their own precedence order where they overlap; keep examples current with
`schemas/schema.sql` and cite it, not the other way around.
