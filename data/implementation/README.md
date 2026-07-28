# data/implementation

One JSON file per open-source or original-silicon realization, filename `<implementation_id>.json`. Each file
bundles every table with exactly one owner in `implementation` (data-model.md §4.1, §4.2): `implementation`
(the row itself), `implementation_chip` (which chips this realizes), `implementation_system` (which systems
it targets), `implementation_path` (repository paths, with `is_top` marking the primary one),
`implementation_platform` (target FPGA platforms), `implementation_machine` (specific MAME machines it
covers), `implementation_dependency` (other implementations it consumes — self-referencing, so a core may
consume a core). The filename stem MUST equal `implementation.implementation_id`, and every row in the file
MUST carry that same id.

**Edit policy:** CURATED. Hand-edited via PR.

- `kind_id` MUST be one of `data/lookup/implementation_kind.json`. An `original_silicon` row carries no
  `repo_url`, `hdl_language_id`, `license_id` or `accuracy_id` — the part as manufactured is not a codebase
  (enforced by `schemas/implementation.schema.json`'s conditional, mirroring the DDL `CHECK`).
- `license_id` MUST be verified by reading the repository's own LICENSE file and MUST resolve to
  `data/lookup/license.json` — never guessed from the project's reputation or README claims.
  `hdl_language_id` MUST resolve to `data/lookup/hdl_language.json`, `accuracy_id` to
  `data/lookup/accuracy_level.json`, `implementation_platform.platform_id` to
  `data/lookup/fpga_platform.json`.
- `implementation_chip.chip_id` and `implementation_system.system_id` MUST resolve into `data/chip/` and
  `data/system/` respectively.
- There is no `known_consumers` field to hand-maintain: it is `implementation_dependency` read backwards, a
  view concern, not a curated one (data-model.md §2.1).
- `verified_against_hardware = 1` requires a citation in `notes` (schema-enforced). Standing rule 3: omit
  `last_reviewed`, `accuracy_id`, etc. rather than guess them.
