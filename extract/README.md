# extract

**Edit policy: GENERATED. Never hand-edit anything in this directory.** Everything here is
the deterministic output of `pipeline mame:extract` and is overwritten wholesale on every
MAME release. A hand-edit survives exactly until the next run and is invisible in the
meantime — which is why corrections are curated rows (`machine_correction`,
`machine_chip_correction`, `machine_system`), not edits here. See TASKS.md standing rule 1
and [`docs/data-model.md`](../docs/data-model.md) §1.5.

## Files

| File                    | What it is                                                                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `machines.raw.json`     | Every MAME machine that survives the filter, with its device references. The input to T6.1's `machine` / `machine_chip` / `machine_unmapped_device` row files. |
| `mame-devices.raw.json` | Every distinct MAME device across those machines, ranked by curation impact. The Phase 3 worklist.                                              |

Both are committed to Git so a MAME bump is reviewable as a diff (PLAN.md §2). Regenerate
with:

```
npm run mame:fetch     --workspace @bomsquad/pipeline   # verified download, cached in .cache/
npm run mame:extract   --workspace @bomsquad/pipeline   # writes both files
```

The pinned release lives in exactly one place, `pipeline/config/mame.json`; the filter and
worklist policy lives in exactly one place, `pipeline/config/mame-extract.json`.

## `*.raw.json` is not a row file

The `.raw.json` suffix means "pipeline intermediate". These two files carry nested device
arrays and are **not** the flat `{table: [rows]}` bundles that
[`docs/data-model.md`](../docs/data-model.md) §4.1 defines, so `pipeline validate` skips
them by suffix. The row files T6.1 emits — `extract/machine.json`,
`extract/machine_chip.json`, `extract/machine_unmapped_device.json`,
`extract/dataset_meta.json` — are the ones that get validated.

Each file opens with a small provenance header naming the MAME release, MAME's own build
string, the verified SHA-256 of the listxml archive, and the config version. There is no
timestamp anywhere: identical inputs must produce byte-identical output (TASKS.md standing
rule 2), and CI regenerates both files and diffs them against what is committed.

Records are written one per line, compact, rather than fully indented. That keeps the diff
of a MAME bump readable at machine granularity, and keeps peak memory flat — the alternative
serialises the whole dataset into one string before a byte reaches disk.

## What MAME's XML does and does not tell us

**There is no genre field.** MAME's `-listxml` output has no genre, category, or
"is this gambling" attribute of any kind. The only thing it says about what a machine *is*
is the driver source file that implements it. The gambling / fruit-machine exclusion is
therefore a hand-curated list of driver paths in `pipeline/config/mame-extract.json`, each
with a written reason, and **it is incomplete by construction**: a gambling title
implemented in a shared or `misc/` driver passes the filter, and nothing in the XML can
tell us. Category data lives in the community-maintained `catver.ini`, with its own licence
and release cadence; ingesting it is a roadmap item, not part of this stage.

Do not paper over this with a heuristic over machine descriptions. "Poker", "Casino" and
"Bingo" appear in the descriptions of plenty of non-gambling arcade titles, and a false
positive silently deletes a board from the dataset with nothing to show that it happened.

Two further limits worth knowing when reading these files:

- **`ismechanical` is MAME's word, not a genre.** It marks machines whose primary output is
  a physical mechanism — pinball, redemption, slot cabinets. It overlaps the gambling
  exclusion without containing it: a video slot machine with no moving parts is not
  mechanical.
- **`<chip name>` is a display name, not a key.** `<chip type="cpu" tag="maincpu"
  name="Zilog Z80"/>` names the part for humans; the key the chip catalog maps is the
  short name on the matching `<device_ref tag=":maincpu" name="z80"/>`. The extractor joins
  the two on their tag, so every socket in these files carries both.
