## Summary

<!-- What does this PR add, fix, or change, and why? -->

## Type of change

<!-- Check all that apply. -->

- [ ] Chip (`data/chip/`)
- [ ] System (`data/system/`)
- [ ] Implementation (`data/implementation/`) or project (`data/project/`)
- [ ] Lookup value (`data/lookup/`)
- [ ] Correction (`data/correction/`) or `chip_equivalence.json` / `mame_device.json`
- [ ] Schema (`schemas/`) — see `schemas/README.md`; a shape change needs `schema.sql` **and** the matching
      `*.schema.json` in the same PR
- [ ] Pipeline (`pipeline/`)
- [ ] Site (`site/`)
- [ ] Docs only
- [ ] Other:

## Checklist

These mirror what CI actually enforces — see `CONTRIBUTING.md` for the full rules.

- [ ] `npm run validate` shows **zero errors** (warnings are fine; if you're leaving one in place, say why
      below — e.g. "license intentionally left unverified, filed as a follow-up")
- [ ] `npm run format` and `npm run lint` are clean
- [ ] If `pipeline/`, `schemas/`, or `data/` changed: `npm run typecheck --workspace @bomsquad/pipeline` and
      `npm run test --workspace @bomsquad/pipeline` pass locally (this is what the CI `pipeline` job runs)
- [ ] If `site/` changed: `npm run typecheck --workspace @bomsquad/site` and
      `npm run test --workspace @bomsquad/site` pass locally (the CI `site` job)
- [ ] Every row file follows the byte-canonical format (data-model.md §4.3): DDL column order within a row,
      entity-table-first-then-bytewise top-level key order, rows sorted by primary key, no `null` values
      written (omit instead), filename stem equals the entity's primary key
- [ ] No hand-edits under `extract/` or `dist/` — both are generated, never curated (Standing rule 1)
- [ ] No renamed slugs — a rename is a new row plus a `chip_name`/`system_name` retired-id alias, with every
      reference re-pointed in the same PR (Standing rule 5)
- [ ] Every non-obvious fact is cited (`notes`, a `chip_datasheet` URL, a correction's `source_url`, or this PR
      description) — omitted rather than guessed where it can't be verified (Standing rule 3)
- [ ] If this adds a `chip_function` value: `docs/taxonomy.md` is updated in the same PR

## Sources

<!-- Datasheets, driver source, manufacturer catalogs, or other citations for any non-obvious fact this PR introduces. -->
