# data/lookup

One file per lookup table (data-model.md §4.2), named after the table: `manufacturer.json` (also carries
`manufacturer_alias`), `license.json`, `chip_function.json`, `chip_family.json`, `chip_role.json`,
`system_kind.json`, `hdl_language.json`, `fpga_platform.json`, `implementation_kind.json`,
`accuracy_level.json`. Row shape, key order and seed values are normative in
[docs/data-model.md](../../docs/data-model.md) §1.1; key order within a row is DDL column order
(`schemas/schema.sql`), never invented.

**Edit policy:** CURATED. Hand-edited via PR. These are dimension tables — "a new manufacturer or a new FPGA
platform is data, not a schema change" (data-model.md §0.2) — so growing a list here is a pure data PR. Every
addition still has to satisfy Standing rule 3 (TASKS.md): omit a column you cannot verify rather than guess
it, and a nullable `country`/`description`/`notes` left out is a curator being honest, not being lazy.

## `manufacturer_alias`

`manufacturer_alias.alias` MUST equal MAME's free-text `manufacturer` attribute **verbatim** — that's what
`v_machine` joins `manufacturer_alias.alias = machine.mame_manufacturer` against. The MAME extract
(`extract/machine.json`) does not exist in this checkout yet, so the exact strings MAME uses (punctuation,
"Ltd." suffixes, multi-manufacturer joins, etc.) are not yet known here and MUST NOT be guessed — a wrong
alias silently mis-resolves a machine's manufacturer, which is worse than an unmapped one. `manufacturer.json`
currently seeds zero `manufacturer_alias` rows for exactly this reason. The bulk alias mapping is a later,
extract-driven curation task: once `extract/machine.json` exists, pull the distinct `mame_manufacturer`
strings and map each to a `manufacturer_id` here.
