/**
 * Applies a curated MAME device map to already-extracted machines (TASKS T3.2).
 *
 * `mame_device` rows sort every device MAME's `-listxml` names into exactly one of three
 * states, and routing a {@link RawMachine}'s devices through them is the whole of what
 * this module does:
 *
 * - **mapped** (`chip_id` set) -> one `machine_chip` row per socket.
 * - **ignored** (`ignore_reason` set) -> no row anywhere. An ignore_reason is a curated
 *   fact ("this is a screen, not a chip"), and a screen is not a socket nobody has filled
 *   yet — it was never a chip, so nothing here may ever count it as missing.
 * - **absent** (no `mame_device` row at all) -> a `machine_unmapped_device` row, grouped
 *   by device short name with `quantity` as the instance count within that machine. This
 *   is the *only* path into that table, and it is never a synthetic chip: there is no
 *   `unknown:*` stub anywhere in this schema (taxonomy.md TB8 — unresolvable means no
 *   `chip` row, not a guess). An uncertain device simply stays unmapped until a curator
 *   gives it one of the two dispositions above, at which point it stops being produced
 *   here at all — `machine_unmapped_device.mame_device` is deliberately not a foreign key
 *   into `mame_device` (schemas/schema.sql), precisely because the row exists *because*
 *   `mame_device` has no matching one.
 *
 * ## What this is not
 *
 * TASKS T6.1 ("Extraction -> row files") owns turning a whole extraction into the row
 * files `pipeline validate`/`pipeline build` actually read: applying `machine_correction`
 * and `machine_system`, writing `extract/machine.json` and its neighbours, and wiring a
 * CLI command. None of that lives here. This module is the one join T6.1 cannot get from
 * anywhere else — the device map applied to a device list — factored out so it can be
 * proved correct against a synthetic map (this file's tests) independently of whatever
 * `data/mame_device/*.json` currently says, since that file is under active curation
 * elsewhere and its contents are expected to change daily. {@link deviceMapFromRows} is
 * the seam: T6.1 loads the real `mame_device` row files through `db/rowfiles.ts` exactly
 * as it loads everything else, and hands the parsed rows here unchanged.
 */
import type { RawMachine } from './parse.js';
import type { Row } from '../db/rowfiles.js';
import { compareBytes } from '../db/rowfiles.js';

/** One `mame_device` row's curation state — mapped xor ignored, the DDL's own `CHECK`. */
export type DeviceMapEntry = { readonly chipId: string } | { readonly ignoreReason: string };

/** `mame_device.mame_device` -> its curation state. No entry at all means unmapped. */
export type DeviceMap = ReadonlyMap<string, DeviceMapEntry>;

/** A `machine_chip` row candidate, in the table's DDL column order. */
export interface MachineChipRow {
  readonly machine_id: string;
  readonly mame_tag: string;
  readonly chip_id: string;
  readonly clock_hz?: number;
}

/** A `machine_unmapped_device` row candidate, in the table's DDL column order. */
export interface MachineUnmappedDeviceRow {
  readonly machine_id: string;
  readonly mame_device: string;
  readonly quantity: number;
}

export interface RoutedDevices {
  /** One row per socket whose device carries a `chip_id`. */
  readonly chips: readonly MachineChipRow[];
  /** One row per `(machine_id, mame_device)` with no `mame_device` row at all. */
  readonly unmapped: readonly MachineUnmappedDeviceRow[];
}

function isIgnored(entry: DeviceMapEntry): entry is { readonly ignoreReason: string } {
  return 'ignoreReason' in entry;
}

/**
 * Routes every device across `machines` through `deviceMap`. Pure and total: every device
 * instance lands in exactly one of `chips`, dropped silently (ignored), or `unmapped` —
 * there is no fourth outcome, and nothing here throws on a device `deviceMap` has never
 * heard of, because "unrecognised" is the ordinary case this function exists to handle.
 *
 * `machines` and each machine's `.devices` may arrive in any order: the result is sorted
 * bytewise before it is returned (standing rule 2), so a caller never has to pre-sort to
 * get a deterministic answer and this file's tests exercise reordering directly rather
 * than trusting that `parse.ts`/`filter.ts` already sorted their input.
 */
export function routeDevices(machines: readonly RawMachine[], deviceMap: DeviceMap): RoutedDevices {
  const chips: MachineChipRow[] = [];
  const unmapped: MachineUnmappedDeviceRow[] = [];

  for (const machine of machines) {
    /** Instance count per unmapped device name, within this one machine. */
    const unmappedCounts = new Map<string, number>();
    for (const device of machine.devices) {
      const entry = deviceMap.get(device.mame_device);
      if (entry === undefined) {
        unmappedCounts.set(device.mame_device, (unmappedCounts.get(device.mame_device) ?? 0) + 1);
        continue;
      }
      if (isIgnored(entry)) continue; // curated non-chip: no row anywhere, ever.
      chips.push({
        machine_id: machine.machine_id,
        mame_tag: device.mame_tag,
        chip_id: entry.chipId,
        ...(device.clock_hz !== undefined ? { clock_hz: device.clock_hz } : {}),
      });
    }
    for (const [mameDevice, quantity] of unmappedCounts) {
      unmapped.push({ machine_id: machine.machine_id, mame_device: mameDevice, quantity });
    }
  }

  return {
    chips: chips.sort(
      (a, b) => compareBytes(a.machine_id, b.machine_id) || compareBytes(a.mame_tag, b.mame_tag),
    ),
    unmapped: unmapped.sort(
      (a, b) =>
        compareBytes(a.machine_id, b.machine_id) || compareBytes(a.mame_device, b.mame_device),
    ),
  };
}

/**
 * Builds a {@link DeviceMap} from already-parsed `mame_device` row-file rows — i.e. what
 * `readRowFile`/`discoverRowFiles` over `data/mame_device/*.json` produce. This does no
 * I/O and knows nothing about `data/`'s layout; it exists purely so T6.1 can turn the
 * curated table into the shape {@link routeDevices} wants with no logic of its own, and so
 * this file's tests never have to import a row-file reader to build one.
 *
 * A row satisfying neither `chip_id` nor `ignore_reason`, or satisfying both, cannot occur
 * in a database that loaded cleanly — `mame_device`'s own `CHECK` refuses it before this
 * function would ever see it — so this is a plain field read, not a second validation of
 * the constraint. A row missing `mame_device` itself (malformed input) is skipped rather
 * than thrown, consistent with this module never treating unrecognised input as fatal.
 */
export function deviceMapFromRows(rows: readonly Row[]): DeviceMap {
  const map = new Map<string, DeviceMapEntry>();
  for (const row of rows) {
    const mameDevice = row['mame_device'];
    if (typeof mameDevice !== 'string') continue;
    const chipId = row['chip_id'];
    const ignoreReason = row['ignore_reason'];
    if (typeof chipId === 'string') map.set(mameDevice, { chipId });
    else if (typeof ignoreReason === 'string') map.set(mameDevice, { ignoreReason });
  }
  return map;
}
