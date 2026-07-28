# data/chip

One JSON file per canonical part, filename `<chip_id>.json`. Each file bundles every table that has exactly
one owner in `chip` (data-model.md §4.1, §4.2): `chip` (the row itself), `chip_name` (alternate names and
retired ids), `chip_datasheet` (documentation links). The filename stem MUST equal `chip.chip_id`, and every
row in the file MUST carry that same `chip_id` — a mismatch is a build failure, not a warning
(data-model.md §4.2's filename rule).

**Edit policy:** CURATED. Hand-edited via PR.

- `function_id` MUST be one of `data/lookup/chip_function.json`; `manufacturer_id` and `family_id`, when set,
  MUST resolve into `data/lookup/manufacturer.json` and `data/lookup/chip_family.json`.
- Standing rule 3 (TASKS.md): research each entry and omit an unverifiable field rather than guess it —
  `manufacturer_id`, `family_id`, `model`, `typical_clock_hz`, `package` and `year_introduced` are all
  nullable for exactly this reason. Cite the source for a non-obvious fact in the row's `notes`.
  `chip_datasheet` rows should link to primary datasheets, not secondary write-ups.
- Never rename `chip_id` once shipped (Standing rule 5); retire the old name into `chip_name` with
  `kind: "retired_id"` and alias it forward instead.
