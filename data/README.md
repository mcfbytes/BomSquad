# data

Curated JSON — the source of truth in Git. `dist/bomsquad.sqlite` (built from this directory plus
`extract/`) is a build output, never hand-edited; `extract/` is regenerated from MAME, never hand-edited
either. The normative layout, file format and byte-identical output rules are
[docs/data-model.md](../docs/data-model.md) §4 — this README is a map, not a spec.

**Edit policy:** CURATED. Hand-edited via PR. Every file must pass `npm run validate` (ajv against
`schemas/*.schema.json` plus a load into a real SQLite database built from `schemas/schema.sql`) before merge.

## Layout

Each curated file is a _table fragment bundle_ (data-model.md §4.1): a JSON object whose top-level keys are
table names and whose values are flat row arrays. There is no nesting and no field named as a key.

| Path                                      | Tables carried                                                                                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lookup/<table>.json`                     | one lookup table each — see `lookup/README.md`                                                                                                                            |
| `chip/<chip_id>.json`                     | `chip`, `chip_name`, `chip_datasheet`                                                                                                                                     |
| `system/<system_id>.json`                 | `system`, `system_name`, `system_driver`, `system_chip`                                                                                                                   |
| `project/<project_id>.json`               | `project`                                                                                                                                                                 |
| `implementation/<implementation_id>.json` | `implementation`, `implementation_chip`, `implementation_system`, `implementation_path`, `implementation_platform`, `implementation_machine`, `implementation_dependency` |
| `mame_device.json`                        | `mame_device` — a single standalone file, not a directory (see below)                                                                                                     |
| `chip_equivalence.json`                   | `chip_equivalence` — a single standalone file, not a directory (see below)                                                                                                |
| `correction/machine.json`                 | `machine_correction`, `machine_system`                                                                                                                                    |
| `correction/machine_chip.json`            | `machine_chip_correction`                                                                                                                                                 |

`mame_device.json` and `chip_equivalence.json` do not exist yet in this checkout: a table whose rows span two
entities with no natural single owner gets its own file (data-model.md §4.2's placement rule), and neither
table has a first curated row yet. A curator creates the file the moment they have one — do not create it
empty as scaffolding.

## What changed from Phase 0

The subdirectories this repo started with — `chips/`, `cores/`, `mappings/`, `overlays/` — were scaffolding
for the pre-relational v1 design and are gone. `cores/` and the `equivalences.json`/`platform-families.json`
mapping files never became load-bearing concepts: a "core" is an `implementation` of kind `fpga_hdl` with an
`implementation_system` row, a "platform family" is a `system`, and corrections are curated
`machine_correction`/`machine_chip_correction`/`machine_system` rows, not a merge/overlay algebra
(docs/data-model.md §1.9, §5; PLAN.md §9's 2026-07-22 note). `implementations/` and `chips/` are renamed to
their singular table names (`implementation/`, `chip/`) to match the file map above exactly.
