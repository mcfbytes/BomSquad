# Contributing a MAME device mapping

**Scope.** This is the deep dive on exactly one contribution type: taking a MAME device off the curation
worklist and turning it into a `mame_device` row (TASKS T3.6). [`CONTRIBUTING.md`](../CONTRIBUTING.md) §6.1
covers "add a chip" in general and is the place for file-format rules, citation policy, and PR mechanics; this
document assumes you've read that and its §0 map first. What this document adds is the part CONTRIBUTING.md
only summarizes: how to find a device worth mapping, how to research it, and — the part that matters
most — how to decide whether it gets a `chip_id`, an `ignore_reason`, or no row at all.

Read before starting, in this order:

1. [`CONTRIBUTING.md`](../CONTRIBUTING.md) §0–§4 — setup, the exact file format, how to run the validator.
2. [`docs/data-model.md`](data-model.md) §1.2 (`mame_device`), §1.3 (`machine_unmapped_device`), §5 (corrections).
3. [`docs/taxonomy.md`](taxonomy.md) — how to pick a `function_id`, and TB8.

---

## 1. What a mapping is

`mame_device` is a dictionary keyed by a single MAME device lookup string (the short name MAME uses internally
— `z80`, `ym2151`, `k007232`, and so on). Every distinct device MAME's `-listxml` output names, across every
machine the extraction filter kept, needs — eventually — a decision. There are exactly three possible outcomes,
and the schema enforces which combinations are legal:

```sql
CHECK ((chip_id IS NULL) <> (ignore_reason IS NULL))
```

| Outcome                   | Row?                                                 | Means                                                               |
| ------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------- |
| **Mapped**                | `mame_device` row with `chip_id`                     | You identified the physical part. It joins the `chip` catalog.      |
| **Ignored**               | `mame_device` row with `ignore_reason`, no `chip_id` | The device is not silicon on a board at all — see §2.2.             |
| **Unresolved (no guess)** | **No row.**                                          | You could not identify it. It stays queued for curation — see §2.3. |

A device can be in exactly one of these three states, never a fourth. There is no `unknown:` stub, no
placeholder chip, no "probably a glue chip" row. `taxonomy.md` calls this TB8: **"Unresolvable means no chip
row, not `custom`."** Filing a guess as `custom` (or as any other function) destroys the one signal that tells
the project it doesn't know something yet, which is worse than the gap itself (Standing rule 3,
`CONTRIBUTING.md` §4).

## 2. Mapped, ignored, or neither — and the mistake that already happened once

This is the one decision in the whole workflow worth getting right, because getting it wrong is silent: a bad
`ignore_reason` doesn't fail validation, doesn't show up in `PRAGMA foreign_key_check`, and doesn't trip a
schema `CHECK`. It just quietly removes a real, unidentified chip from every coverage number the project
publishes — the mapped-instance share, the per-system coverage, the Prospector — as if the socket didn't exist.

### 2.1 `chip_id` — you identified the physical part

Use this when you can point at a real, named chip and are confident enough to add (or reuse) a `chip` row for
it. "Identified" doesn't require a datasheet in hand — MAME's own source and metadata are often enough (§3
below) — but it does require an actual answer to "what part is this," not a plausible-sounding category.

### 2.2 `ignore_reason` — the device is not silicon on a board

Use this when the MAME device you're looking at **isn't a discrete chip at all**. The seeded examples in
`data/mame_device.json` fall into a few recurring shapes, all real, all currently in the file:

- **A MAME abstraction with no hardware counterpart**: `screen` ("Display abstraction (CRT/LCD raster
  target); not a chip"), `gfxdecode`, `tilemap`, `timer`, `palette`, `discrete` — emulator-internal helpers.
- **A drive, media, or peripheral assembly, not a component**: `cdrom`, `floppy_35_dd`, `ticket_dispenser`,
  `coin_hopper` — real hardware, but not board silicon.
- **An on-die functional block of a chip mapped elsewhere**: `segapsg` ("On-die SN76489-compatible PSG
  section of a Sega VDP... the VDP package carries it and is mapped via its own device"), `nesapu`, `scudsp`,
  `paula_fdc` — a sub-block MAME models as its own device, whose parent package already has a `chip_id`
  through a different `mame_device` row.
- **A bus, slot, or connector abstraction**: `isa16_slot`, `usb_connector`, `jvs_port`.

The common thread: after you ignore the device, nothing false remains asserted. The board's actual chip either
has its own mapped row (the on-die-block case) or never existed as a discrete part (the abstraction/media
case). An `ignore_reason` is a **positive claim that there is no chip here to find** — not a way to close out
a device you haven't gotten to yet.

### 2.3 Neither — you could not identify it (TB8)

Use this when the device is presumably real silicon but you don't know what part it is. **Write no row.** Do
not:

- guess a `chip_id` for a part you're not sure of,
- write a plausible-sounding `ignore_reason` because you couldn't find an identity and want the worklist to
  shrink,
- file it under `custom` in the chip taxonomy as a way to "resolve" it without actually resolving it
  (taxonomy.md P3, TB8).

A device with no row surfaces automatically: extraction emits a `machine_unmapped_device` row for it (never a
synthetic chip — data-model.md §1.3), and it's counted, ranked, and queued by the view
`v_mame_device_worklist`. That is the entire point of leaving it alone — the signal survives, and the next
curator (possibly you, later, with more information) sees it exactly where it belongs.

### 2.4 The worked cautionary example — this already happened once

This project shipped the mistake described in §2.3 and then found and fixed it, and the fix is the single best
teaching example available, because it's real and it's in the Git history (commit `61920a6`, "Phase 3: 69
arcade systems, audit corrections, taxonomy spec fixes"). An audit of the seed device map found **eleven**
`ignore_reason` rows whose text didn't actually assert "this isn't a chip" — it asserted "this is presumably a
real chip, but I couldn't identify it," which is exactly the case §2.3 says gets **no row**, not an ignore row.
Five of them, verbatim, before the fix:

```jsonc
{ "mame_device": "dmadac", "ignore_reason": "Generic DMA-fed DAC stand-in; does not identify the physical DAC part." },
{ "mame_device": "filter_biquad", "ignore_reason": "Models an op-amp biquad filter stage generically; the physical op-amp and network are not identified." },
{ "mame_device": "generic_fifo_u32_device", "ignore_reason": "Generic FIFO emulation helper; does not identify a physical part." },
{ "mame_device": "idectrl32", "ignore_reason": "IDE controller function modelled as a bus abstraction; no discrete identified part." },
{ "mame_device": "idectrl32bm", "ignore_reason": "IDE controller function modelled as a bus abstraction (typically a chipset function block); no discrete identified part." }
```

Read each `ignore_reason` again: "**does not identify** the physical part," "**not identified**," "**no
discrete identified part**." Every one of those phrases is a confession that the device might be a real,
mappable chip — it just wasn't found yet. That's the §2.3 case, and the fix was simply to delete the rows.
Once deleted, extraction re-surfaces all five as ordinary unmapped devices, exactly where they should have
been the whole time. You can see them there today — they're still unmapped as of this writing:

```
$ node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('dist/bomsquad.sqlite', { readOnly: true });
console.log(db.prepare(
  \"SELECT mame_device, instance_count, machine_count FROM v_mame_device_worklist \" +
  \"WHERE mame_device IN ('dmadac','filter_biquad','generic_fifo_u32_device','idectrl32bm') \" +
  \"ORDER BY instance_count DESC\"
).all());
"
[
  { mame_device: 'idectrl32bm', instance_count: 367, machine_count: 222 },
  { mame_device: 'dmadac', instance_count: 235, machine_count: 109 },
  { mame_device: 'filter_biquad', instance_count: 177, machine_count: 46 },
  { mame_device: 'generic_fifo_u32_device', instance_count: 82, machine_count: 41 }
]
```

`idectrl32bm` alone accounts for 367 device instances across 222 machines — that's 367 sockets that a wrong
`ignore_reason` had silently deleted from the mapped-instance-share denominator's numerator-side accounting,
with nothing anywhere to show it had happened. The commit that fixed this moved the project's headline metric
from 82.04% to 81.32% — a **drop**, because the metric had been artificially inflated by devices that were
never actually resolved. The commit message states the principle plainly: _"An ignore removes a socket from
coverage silently; an unmapped device queues in `v_mame_device_worklist`."_

**The test to apply to your own `ignore_reason` text before you commit it:** if the sentence you're about to
write could be paraphrased as "I don't know what this is," it is not an `ignore_reason` — it's an unmapped
device, and the fix is to delete the row (or never write it). An `ignore_reason` should read like a closing
argument (`"Display abstraction (CRT/LCD raster target); not a chip"`), never like an open question
(`"...does not identify the physical part"`).

## 3. Step by step

### Step 1 — Claim a device from the worklist

The worklist is a live view over the curated `mame_device` table joined against extraction output, so it needs
a built database to query. Build one from the repo's already-committed `data/` and `extract/` row files —
this doesn't need MAME source or a network fetch, since `extract/machine.json`,
`extract/machine_chip.json`, and `extract/machine_unmapped_device.json` are already committed:

```
$ npm run build:db --workspace @bomsquad/pipeline
> @bomsquad/pipeline@0.0.0 build:db
> tsx src/cli.ts build

build: loaded 70263 rows from 315 row files
build: corrections applied to machine_chip — 0 removed, 0 added, 0 set (data-model.md §5.1)
build: /mnt/source/BomSquad/dist/bomsquad.sqlite
  dataset 2026-07-28 · MAME 0.288 · schema 2.0.0 · thresholds 2.0.0
  rows    70263 from 315 files
  counts  chip 169 · system 69 · machine 9775 · implementation 41 · project 19
  mapped  34566 of 62651 device instances (0.5517)
  devices 168 mapped · 183 ignored · 3527 unmapped
  size    5.68 MiB raw · 1.22 MiB brotli · ceiling 48.00 MiB
  sha256  fd97f89ef51883c86b82d509dbfdb821791d4cb2d613c9f10596cdedf6a2ea21
  warnings CHIP_MANUFACTURER_FAMILY_MISMATCH 9 · ... · UNMAPPED_DEVICE_HIGH_IMPACT 33
  wrote   /mnt/source/BomSquad/dist/quality-report.json
  wall clock 6.7s
```

Now query `v_mame_device_worklist` — the exact query is `docs/data-quality.md` §6's, which also attaches
sample machine ids so the device is actually researchable, using Node's built-in `node:sqlite` (no
extra dependency; this is the same engine the pipeline itself uses):

```
$ node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('dist/bomsquad.sqlite', { readOnly: true });
const rows = db.prepare(\`
  SELECT w.mame_device, w.instance_count, w.machine_count,
         (SELECT group_concat(s.machine_id, ' ')
          FROM (SELECT machine_id FROM machine_unmapped_device x
                WHERE x.mame_device = w.mame_device
                ORDER BY machine_id LIMIT 5) s) AS sample_machines
  FROM v_mame_device_worklist w
  WHERE w.instance_count >= (SELECT value FROM threshold WHERE name = 'issue_generator.min_instance_count')
    AND w.machine_count  >= (SELECT value FROM threshold WHERE name = 'issue_generator.min_machine_count')
  ORDER BY w.instance_count DESC, w.mame_device ASC
  LIMIT 5;
\`).all();
for (const r of rows) console.log(r.mame_device, r.instance_count, r.machine_count, r.sample_machines);
"
idectrl32bm 367 222 asuscubx asuscusc asuspolo avalnc13 avalnc25
megadrive_io_port 366 122 32x 32x_scd 3in1mbc aladmdb atgame40
dmadac 235 109 11beat 39in1 a51site4 aleck64 batmanfr
filter_biquad 177 46 amazon archrivl armedf blasted cclimbr2
pc_lpt 116 116 a486ap4 a486sp3 a51site4 aa3010 aa486s
```

This is the exact production query — `docs/data-quality.md` §6, thresholds read live out of the `threshold`
table rather than hardcoded, so it's identical to what a "good first mapping" issue would be filed against.
Drop the two `WHERE` thresholds (or lower them) to browse further down the list; there are 3,527 unmapped
devices in total as of this writing (`SELECT COUNT(*) FROM v_mame_device_worklist`), most of them long-tail.

**No build available, or don't want one?** The same information exists, pre-aggregated, in the committed
`extract/mame-devices.raw.json` — the file `pipeline mame:extract` produces and the one
`docs/data-model.md`'s file map calls "the Phase 3 worklist." Reading it directly needs nothing but Node:

```
$ node -e "
const { devices } = JSON.parse(require('fs').readFileSync('extract/mame-devices.raw.json', 'utf8'));
console.log(devices.find(d => d.mame_device === 'k007232'));
"
{
  mame_device: 'k007232',
  instance_count: 33,
  machine_count: 26,
  chip_types: [ 'audio' ],
  chip_names: [ 'Konami 007232 PCM Controller' ],
  sample_machine_ids: [
    'ajax', 'aliens', 'blkpnthr', 'bottom9',
    'chqflag', 'citybomb', 'crimfght', 'devilw',
    'devstors', 'fastlane'
  ]
}
```

`chip_types` and `chip_names` come straight from MAME's own XML (`<chip type="..." name="...">`) and are
frequently the single best research lead you'll get — see Step 2.

A third way to see the same signal: `pipeline validate --json` emits an `UNMAPPED_DEVICE_HIGH_IMPACT`
diagnostic per device above the same two thresholds (it reads the identical `v_quality_warning` predicate), so
`npm run validate --workspace pipeline -- --json` also works as a worklist browser if you already have a
database built for other reasons.

### Step 2 — Research the device

For this walkthrough, take `k007232` — not one of the top-impact entries above (33 instances, 26 machines,
below the issue-generator thresholds), but a real, currently-unmapped device, exactly the kind of "held-out"
mapping a contributor claims day to day.

Sources, roughly in order of how much they're worth trusting:

1. **MAME's own metadata**, already in front of you from Step 1: `chip_names: ["Konami 007232 PCM
Controller"]`. MAME's authors named this device after what it is, not after an emulation implementation
   detail — "PCM Controller" is a real functional claim, not a guess.
2. **The sample machines.** `ajax`, `aliens`, `bottom9`, `chqflag`, `crimfght` are all Konami arcade titles
   from the mid-to-late 1980s — consistent with a Konami-manufactured custom part of that era, not, say, a
   licensed third-party chip.
3. **MAME driver source** (`src/devices/sound/k007232.cpp` in the `mamedev/mame` repository, BSD-3-Clause) —
   not fetched as part of this walkthrough, but the next thing a contributor should open before finalizing
   fine-grained specs (exact channel count, clock derivation) that go beyond what's already confirmed above.
   `data/chip/*.notes` and commit messages are where you'd cite it once you have.
4. **A datasheet or manufacturer reference**, if one is findable — goes in `chip_datasheet` (§6.1 of
   `CONTRIBUTING.md`) once you have a URL, not before.

Existing `mame_device.json` entries for the same manufacturer are also a useful sanity check — searching the
file for `"manufacturer_id": "konami"` shows four Konami chips already cataloged (`k053252`, `k054539`,
`k055555`, `k056832`), confirming `konami` already exists as a `manufacturer_id` and giving you a feel for how
terse (or not) this project's Konami-chip descriptions run.

**What you have, and don't have, at this point.** You can confidently say: this is a real Konami PCM
(sample-playback) sound chip, used on 1980s–1990s Konami arcade boards. You cannot yet responsibly state its
exact channel count, package, or typical clock without opening the MAME source or a datasheet — so the worked
example below simply omits those fields, per Standing rule 3 ("omit a field you can't verify — do not
guess"). That is not a shortcut taken only for this walkthrough; it's the same choice a real contributor
should make.

### Step 3 — Decide: mapped, ignored, or neither

`k007232` is a real, named, identifiable chip (§2.1) — not a bus/slot/media abstraction, not an on-die block
already carried by a parent device's row (§2.2), and not unidentifiable (§2.3). It gets a `chip_id`.

### Step 4 — Pick `function_id`

Walk `docs/taxonomy.md` §3's decision guide in order:

- Q0 (is it genuinely unknown?) — no, Step 2 identified it.
- Q1 (executes a general instruction stream?) — no, it's a sound peripheral, not a CPU/MCU.
- Q2 (DSP/math engine running microcode?) — no.
- Q3 (security device?) — no.
- Q4 (video?) — no.
- Q5 (generates/mixes/converts audio?) — **yes** → §3.2's audio sub-guide:
  - A1 (FM synthesis)? No.
  - A2 (plays back recorded samples from ROM/RAM)? **Yes** — MAME's own name says "PCM Controller," and PCM
    is exactly A2's case. → `sound-pcm`.

No tie-break rule in §2 fires ahead of this (TB1–TB7 don't apply to a fixed-function sample player), so the
decision-guide order stands unmodified. `function_id: sound-pcm`.

### Step 5 — Write the two rows

One new file, `data/chip/k007232.json` (data-model.md §4.2's chip bundle — here, just the `chip` row; no
alias or datasheet rows yet, since none were found in Step 2):

```json
{
  "chip": [
    {
      "chip_id": "k007232",
      "display_name": "K007232",
      "function_id": "sound-pcm",
      "manufacturer_id": "konami",
      "description": "PCM sample-playback sound controller used on 1980s-1990s Konami arcade boards."
    }
  ]
}
```

And one new row inside the existing `data/mame_device.json`, inserted in bytewise-ascending key order — it
sorts right after `jvs_port` and before `k053252`:

```json
    {
      "mame_device": "jvs_port",
      "ignore_reason": "JVS bus port/connector abstraction."
    },
    {
      "mame_device": "k007232",
      "chip_id": "k007232",
      "note": "MAME's own chip_names entry for this device reads 'Konami 007232 PCM Controller' (extract/mame-devices.raw.json); sample playback per taxonomy A2."
    },
    {
      "mame_device": "k053252",
```

The `note` field isn't required by the schema, but it's cheap insurance for the next curator (or auditor —
see §2.4's commit) who wonders why this row exists: it names the evidence, not just the conclusion.

### Step 6 — Validate

```
$ npm run validate --workspace pipeline -- --strict
```

Both new rows validate cleanly against a checkout carrying them: `chip_id`/`function_id`/`manufacturer_id` all
resolve (`konami` and `sound-pcm` already exist as lookup rows), the `mame_device` row satisfies the
mapped-xor-ignored `CHECK` (`chip_id` set, `ignore_reason` absent), and no `CHIP_MISSING_METADATA` warning
fires because both `manufacturer_id` and `description` are present. Confirmed against a scratch copy of this
exact diff, run through the real validator:

```
316 files, 70265 rows, 0 errors, 1943 warnings
```

— one more file, two more rows, zero new errors or warnings, exactly the two additions above (the base
checkout validates at `315 files, 70263 rows, 0 errors, 1943 warnings`). If you'd instead written the CHECK
violation this document warns against — say, a row carrying both `chip_id` and `ignore_reason` — the
validator catches it immediately and by name, in two independent layers at once (the database `CHECK` and the
JSON Schema's `oneOf`):

```
ERROR data/mame_device.json: mame_device[example].chip_id [check-violation] violates CHECK (chip_id IS NULL) <> (ignore_reason IS NULL) (chip_id='z80')
      fix: amend chip_id so it satisfies CHECK (chip_id IS NULL) <> (ignore_reason IS NULL) in schemas/schema.sql
ERROR data/mame_device.json: mame_device[example].chip_id [schema-shape] boolean schema is false (false schema)
      fix: correct chip_id against schemas/mame_device.schema.json
ERROR data/mame_device.json: mame_device[example].ignore_reason [schema-shape] boolean schema is false (false schema)
      fix: correct ignore_reason against schemas/mame_device.schema.json
```

That's the mechanical half of §2's rule (both fields set, or the row missing one of `chip_id`/`ignore_reason`
entirely) — a hard, unmissable error. What the validator **cannot** catch is the semantic version §2.4 walks
through: a syntactically legal `ignore_reason` whose own words admit the part was never identified. That one
is a review-time judgment call, which is exactly why §2.4 exists.

### Step 7 — Rebuild and check the share moved (optional, but a good sanity check)

```
$ npm run build:db --workspace @bomsquad/pipeline
```

`dist/quality-report.json`'s `instances.mapped_instance_share` should tick up by the newly-mapped device's
instance count divided into the same denominator (`docs/data-quality.md` §5 has the exact metric). For a
33-instance device against a ~62,651-instance denominator, the move is small and won't visibly change the
rounded four-decimal figure — that's expected for an ordinary mapping; the multi-hundred-instance devices in
Step 1's top-5 move it more visibly.

### Step 8 — Open the PR

Follow `CONTRIBUTING.md` §7's checklist as-is: `npm run validate` clean, `npm run format`/`npm run lint`
clean, a citation for every non-obvious fact (here: MAME's own `chip_names` field, cited in the `note`), no
hand-edits under `extract/` or `dist/`, no renamed slugs. Use the "Map MAME device" PR template
(`.github/PULL_REQUEST_TEMPLATE.md` / `.github/ISSUE_TEMPLATE/`) if proposing the mapping before writing the
JSON yourself.

## 4. Quick-reference checklist

- [ ] Built (or already have) `dist/bomsquad.sqlite`, or read `extract/mame-devices.raw.json` directly.
- [ ] Queried `v_mame_device_worklist` (or the raw file) and picked one real, currently-unmapped device.
- [ ] Read MAME's own `chip_names`/`chip_types` for it, and looked at its sample machines.
- [ ] Asked, honestly: can I name the actual part? If **no** → stop, write no row (§2.3). Done.
- [ ] If **yes, and it's not a chip at all** (abstraction, media, on-die block already mapped elsewhere) →
      write an `ignore_reason` that states a closing fact, never an open question (§2.2, §2.4's test).
- [ ] If **yes, it's a real part** → walk `docs/taxonomy.md` §2 then §3 to get exactly one `function_id`.
- [ ] Wrote `data/chip/<chip_id>.json` (new chip) or confirmed the chip already exists.
- [ ] Added the `mame_device` row in `data/mame_device.json`, bytewise-sorted, with a `note` citing your
      evidence for anything non-obvious.
- [ ] Omitted every field you couldn't verify — no guessed clock, package, year, or manufacturer.
- [ ] `npm run validate --workspace pipeline -- --strict` is clean.
- [ ] PR follows `CONTRIBUTING.md` §7.
