/**
 * The device worklist (TASKS T2.4): every distinct MAME device across the kept machines,
 * ranked by how much of the dataset mapping it would unlock.
 *
 * This file is not a report. It is the **input to Phase 3**: a curator works down it,
 * turning `mame_device` short names into `mame_device` rows that point at `chip` rows, and
 * every row they map removes real unmapped instances from real machines. The ordering is
 * therefore a product decision, not a presentation detail — it decides what gets curated
 * first — and it is:
 *
 * 1. **descending `instance_count`** — total sockets across all kept machines. Instances,
 *    not machines, because that is what `machine_chip` rows are counted in and what
 *    `v_quality_warning`'s `MAPPED_INSTANCE_SHARE_LOW` gate measures.
 * 2. **then `mame_device` bytewise ascending** — a tiebreak that is a total order, so the
 *    file is byte-identical across runs and machines. Locale collation would not be
 *    (`compareBytes`, data-model.md §4.3).
 *
 * `machine_count` is carried alongside but does not sort: a device in 400 machines once
 * each and a device in 4 machines a hundred times each are equally worth an hour of
 * curation, and only `instance_count` says so.
 *
 * `chip_name` and `chip_types` are MAME's own words for the part, from `<chip>`. They are
 * what makes the list usable without opening MAME's source — `sega_315_5195` means
 * nothing, `Sega 315-5195 Memory Mapper` means a great deal — and they are exactly the
 * fields a curator copies into a `chip` row. A device MAME never described with a `<chip>`
 * element (a bus, a slot, a screen) simply has neither key, which is itself the signal
 * that it is probably an `ignore_reason`, not a chip.
 */
import type { RawMachine } from './parse.js';
import { compareBytes } from '../db/rowfiles.js';

/** One curation candidate. */
export interface WorklistEntry {
  /** MAME device short name — `mame_device.mame_device`, the key a curator maps. */
  readonly mame_device: string;
  /** Sockets across all kept machines. The ranking key. */
  readonly instance_count: number;
  /** Distinct kept machines using it. */
  readonly machine_count: number;
  /** `<chip type>` values MAME gave it anywhere, bytewise sorted. Absent if never a `<chip>`. */
  readonly chip_types?: readonly string[];
  /** `<chip name>` display names MAME gave it, bytewise sorted. Absent if never a `<chip>`. */
  readonly chip_names?: readonly string[];
  /** A bounded, bytewise-sorted sample of machines using it, for spot-checking a mapping. */
  readonly sample_machine_ids: readonly string[];
}

interface Tally {
  instances: number;
  machines: number;
  readonly types: Set<string>;
  readonly names: Set<string>;
  /** Kept bounded during accumulation, so a 4,000-machine device never holds 4,000 ids. */
  readonly samples: string[];
}

/**
 * Builds the worklist from the filtered machines.
 *
 * `sampleSize` bounds the sample per device. The samples are collected in the *sorted*
 * machine order the filter produced and then re-sorted, so the sample is a function of
 * the machine set alone — not of which machine happened to be visited first.
 */
export function buildWorklist(
  machines: readonly RawMachine[],
  sampleSize: number,
): WorklistEntry[] {
  const tallies = new Map<string, Tally>();

  for (const machine of machines) {
    /** Devices already counted for this machine, so `machine_count` counts machines. */
    const seen = new Set<string>();
    for (const device of machine.devices) {
      let tally = tallies.get(device.mame_device);
      if (tally === undefined) {
        tally = { instances: 0, machines: 0, types: new Set(), names: new Set(), samples: [] };
        tallies.set(device.mame_device, tally);
      }
      tally.instances += 1;
      for (const type of device.chip_types ?? []) tally.types.add(type);
      if (device.chip_name !== undefined) tally.names.add(device.chip_name);
      if (!seen.has(device.mame_device)) {
        seen.add(device.mame_device);
        tally.machines += 1;
        if (tally.samples.length < sampleSize) tally.samples.push(machine.machine_id);
      }
    }
  }

  const entries: WorklistEntry[] = [];
  for (const [mameDevice, tally] of tallies) {
    entries.push({
      mame_device: mameDevice,
      instance_count: tally.instances,
      machine_count: tally.machines,
      ...(tally.types.size > 0 ? { chip_types: [...tally.types].sort(compareBytes) } : {}),
      ...(tally.names.size > 0 ? { chip_names: [...tally.names].sort(compareBytes) } : {}),
      sample_machine_ids: [...tally.samples].sort(compareBytes),
    });
  }
  // Impact first, then a total order on the name. Never the Map's insertion order: that
  // is the document's order, which is not a property of the dataset.
  return entries.sort(
    (a, b) => b.instance_count - a.instance_count || compareBytes(a.mame_device, b.mame_device),
  );
}
