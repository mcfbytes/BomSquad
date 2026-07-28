# data/correction

Curated fixes and assignments layered onto the generated `extract/` tables (data-model.md §5). Unlike every
other directory here, this is not one-file-per-entity: there are exactly two fixed filenames, because each
carries tables keyed by `machine_id` rather than by a single owning entity.

| Path                                | Tables carried                         | Applied by                                                                                            |
| ----------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `data/correction/machine.json`      | `machine_correction`, `machine_system` | `v_machine`, `v_machine_system` (a `COALESCE`/`CASE`, no load-time pass)                              |
| `data/correction/machine_chip.json` | `machine_chip_correction`              | a three-step remove/add/set pass after `extract/` loads, before any view is read (data-model.md §5.1) |

**Edit policy:** CURATED. Hand-edited via PR. This is the _only_ place a curator overrides generated data —
never hand-edit `extract/` directly; re-extraction from a fresh MAME release would silently discard any fix
made there. Every correction row requires provenance:

- `machine_correction.reason` and `machine_chip_correction.reason` are mandatory ("Mandatory provenance" per
  their schemas) — a correction without a stated reason is not reviewable.
- `machine_system` is an **assignment**, not a correction, so its `reason` is optional: one driver source file
  legitimately hosts several systems, and recording which machine belongs to which is normal curation, not an
  apology for wrong generated data. A `machine_system` row's mere presence is authoritative and overrides
  `system_driver`'s bulk default; omitting `system_id` on a present row means "deliberately no system."
- `machine_chip_correction.op` is `add`, `remove` or `set`: `remove` carries no value columns, `set` must
  change at least one of `clock_hz`/`quantity`. There is no fourth op — inventing one is a schema change, not
  a data change (data-model.md §0.2).

`machine_correction.manufacturer_id` and `machine_chip_correction.chip_id` MUST resolve into
`data/lookup/manufacturer.json` and `data/chip/` respectively; `machine_system.system_id` into `data/system/`.
