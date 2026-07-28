# data/system

One JSON file per curated board/platform, filename `<system_id>.json`. Each file bundles every table with
exactly one owner in `system` (data-model.md §4.1, §4.2): `system` (the row itself), `system_name` (aliases
and retired ids), `system_driver` (bulk default mapping from a MAME driver source file to this system),
`system_chip` (the curated BOM: role + chip + clock for this board). The filename stem MUST equal
`system.system_id`, and every row in the file MUST carry that same `system_id`.

**Edit policy:** CURATED. Hand-edited via PR.

- `kind_id` MUST be one of `data/lookup/system_kind.json`; `manufacturer_id`, when set, MUST resolve into
  `data/lookup/manufacturer.json`.
- `system_chip.role_id` MUST be one of `data/lookup/chip_role.json`; `system_chip.chip_id` MUST resolve into
  an existing `data/chip/<chip_id>.json`.
- A `system` is the replacement for the old "platform family" concept (PLAN.md §9's 2026-07-22 note,
  data-model.md §1.9): there is no separate `platform_family` table. One driver `.cpp` legitimately hosting
  several systems is the reason `machine_system` exists as a per-machine override of `system_driver`'s bulk
  default — that override is curated data too, but it lives in `data/correction/machine.json`, not here,
  because it is keyed by `machine_id` rather than by a single `system_id` owner.
- Standing rule 3: omit `year_introduced`, `description` or `notes` rather than guess them.
