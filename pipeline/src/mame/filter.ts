/**
 * Filter rules (TASKS T2.3): which of MAME's 50,097 machines belong in the dataset.
 *
 * ## Every machine gets exactly one reason
 *
 * The acceptance criterion is that "the run log accounts for every dropped machine by
 * reason", which only holds if kept + Σ dropped = total, exactly. Reasons therefore
 * overlap in reality — 15,801 machines are mechanical, and thousands of those are also
 * clones — and the first rule to fire wins. {@link DROP_REASONS} fixes that order, so the
 * counts are reproducible and mean something stable across releases rather than shifting
 * whenever a rule is reordered.
 *
 * The order is `device → mechanical → clone → bios → excluded_driver`, chosen so each
 * reason answers the most fundamental objection to the machine first: a MAME device model
 * is not hardware anyone owns, a pinball cabinet is not a board with a BOM, a clone is a
 * duplicate of something already kept, and only then is the question "is this driver
 * gambling hardware" worth asking.
 *
 * ## `clone_count` is why clones are counted, not merely skipped
 *
 * `machine.clone_count` is a base fact MAME states about a parent (data-model.md §1.3):
 * how many sets this filter folded away. Nothing in the shipped database can derive it,
 * because the clone rows are not there. It is accumulated here, keyed by `cloneof`, and
 * attached in {@link applyFilter}'s second phase — a clone is not guaranteed to appear
 * after its parent in the document, so a single-pass "increment the parent I already
 * have" would undercount.
 *
 * ## Driver exclusion is a curated list, and that is a limitation, not a design
 *
 * MAME's XML has no genre field (see `config/mame-extract.json` and `extract/README.md`).
 * The only thing the document says about what a machine *is* is which driver source file
 * implements it, so the gambling/fruit-machine exclusion is a list of driver paths, an
 * entry is either an exact `dir/file.cpp` or a `dir/` prefix, and `keep_sourcefile` names
 * the exceptions inside an excluded prefix. It is incomplete by construction and there is
 * no way for it not to be.
 */
import type { FilterConfig, SourcefileRule } from './config.js';
import type { RawMachine } from './parse.js';
import { compareBytes } from '../db/rowfiles.js';

/**
 * Drop reasons, in the order they are tested. Order is part of the contract: it decides
 * which reason a machine that qualifies for several is counted under.
 */
export const DROP_REASONS = ['device', 'mechanical', 'clone', 'bios', 'excluded_driver'] as const;
export type DropReason = (typeof DROP_REASONS)[number];

/** What the filter decided about one machine. */
export type Decision =
  | { readonly kept: true }
  | { readonly kept: false; readonly reason: DropReason; readonly rule?: SourcefileRule };

/** Counts per reason plus the per-rule breakdown that makes the exclude list reviewable. */
export interface FilterStats {
  readonly total: number;
  readonly kept: number;
  /** Every reason in {@link DROP_REASONS}, present even at zero, so a diff shows a rule dying. */
  readonly dropped: ReadonlyMap<DropReason, number>;
  /** Exclude-list pattern → machines it dropped, bytewise sorted by pattern. */
  readonly excludedByRule: ReadonlyMap<string, number>;
  /** Exclude-list patterns that matched nothing — a typo, or a driver MAME renamed. */
  readonly unusedExcludeRules: readonly string[];
  /** Keep-list patterns that matched nothing, likewise. */
  readonly unusedKeepRules: readonly string[];
}

export interface FilterResult {
  /** Survivors, bytewise sorted by `machine_id`, each with `clone_count` attached. */
  readonly machines: readonly RawMachine[];
  readonly stats: FilterStats;
}

/**
 * True when `sourcefile` is matched by `pattern`. A pattern ending in `/` is a directory
 * prefix covering every driver beneath it; anything else is an exact path. There is no
 * glob syntax on purpose — a wildcard in this list would make "which machines did we
 * drop, and why" a question you have to run the pipeline to answer.
 */
export function matchesSourcefile(pattern: string, sourcefile: string): boolean {
  return pattern.endsWith('/') ? sourcefile.startsWith(pattern) : sourcefile === pattern;
}

function firstMatch(
  rules: readonly SourcefileRule[],
  sourcefile: string,
): SourcefileRule | undefined {
  return rules.find((rule) => matchesSourcefile(rule.pattern, sourcefile));
}

/**
 * The decision for one machine, and the only place a drop reason is chosen. Pure: the
 * golden fixture for T2.3 drives this directly rather than through the file pipeline.
 */
export function decide(config: FilterConfig, machine: RawMachine): Decision {
  if (config.dropDevices && machine.is_device === 1) return { kept: false, reason: 'device' };
  if (config.dropMechanical && machine.is_mechanical === 1) {
    return { kept: false, reason: 'mechanical' };
  }
  if (config.parentsOnly && machine.cloneof !== undefined) return { kept: false, reason: 'clone' };
  if (config.dropBios && machine.is_bios === 1) return { kept: false, reason: 'bios' };
  const kept = firstMatch(config.keepSourcefile, machine.mame_sourcefile);
  if (kept === undefined) {
    const excluded = firstMatch(config.excludeSourcefile, machine.mame_sourcefile);
    if (excluded !== undefined) {
      return { kept: false, reason: 'excluded_driver', rule: excluded };
    }
  }
  return { kept: true };
}

/** An in-progress filter run. {@link createFilter} is the only way to make one. */
export interface FilterAccumulator {
  /** Offers one parsed machine. Dropped machines are counted and released immediately. */
  readonly add: (machine: RawMachine) => void;
  /** Attaches clone counts, sorts, and returns the run. Call once. */
  readonly finish: () => FilterResult;
}

/**
 * A filter that consumes machines as the parser produces them.
 *
 * This is streaming rather than array-shaped for one reason, and it is the RSS budget of
 * TASKS T2.2: MAME 0.288 has 50,097 machines carrying 775,488 device references, and
 * about four fifths of them are dropped. Collecting every parsed machine and filtering
 * afterwards holds all of that at once; deciding as they arrive holds only the 9,775
 * survivors and a `cloneof` counter, which is a fraction of the memory and is the
 * difference between peak RSS scaling with MAME's *machine count* and with its XML size.
 */
export function createFilter(config: FilterConfig): FilterAccumulator {
  const kept: RawMachine[] = [];
  const dropped = new Map<DropReason, number>(DROP_REASONS.map((reason) => [reason, 0]));
  const excludedByRule = new Map<string, number>();
  const usedKeepRules = new Set<string>();
  /** Parent id → clone sets MAME lists under it. Counted for every clone, kept or not. */
  const cloneCounts = new Map<string, number>();
  let total = 0;

  return {
    add(machine): void {
      total += 1;
      if (machine.cloneof !== undefined) {
        cloneCounts.set(machine.cloneof, (cloneCounts.get(machine.cloneof) ?? 0) + 1);
      }
      const decision = decide(config, machine);
      if (decision.kept) {
        const keptRule = firstMatch(config.keepSourcefile, machine.mame_sourcefile);
        if (keptRule !== undefined) usedKeepRules.add(keptRule.pattern);
        kept.push(machine);
        return;
      }
      dropped.set(decision.reason, (dropped.get(decision.reason) ?? 0) + 1);
      if (decision.rule !== undefined) {
        const pattern = decision.rule.pattern;
        excludedByRule.set(pattern, (excludedByRule.get(pattern) ?? 0) + 1);
      }
    },

    finish(): FilterResult {
      // Clone counts are complete only now: MAME's document order is not parents-first,
      // so a single-pass "increment the parent I already have" would undercount. A parent
      // with no clones gets no key at all, because `machine.clone_count` is
      // `CHECK (clone_count IS NULL OR clone_count >= 1)` and an absent key is how this
      // model writes NULL (data-model.md §4.3).
      const machines = kept
        .map((machine) => {
          const count = cloneCounts.get(machine.machine_id);
          return count === undefined ? machine : withCloneCount(machine, count);
        })
        .sort((a, b) => compareBytes(a.machine_id, b.machine_id));

      return {
        machines,
        stats: {
          total,
          kept: machines.length,
          dropped,
          excludedByRule: new Map([...excludedByRule].sort((a, b) => compareBytes(a[0], b[0]))),
          unusedExcludeRules: config.excludeSourcefile
            .filter((rule) => !excludedByRule.has(rule.pattern))
            .map((rule) => rule.pattern)
            .sort(compareBytes),
          unusedKeepRules: config.keepSourcefile
            .filter((rule) => !usedKeepRules.has(rule.pattern))
            .map((rule) => rule.pattern)
            .sort(compareBytes),
        },
      };
    },
  };
}

/**
 * {@link createFilter} over a finished collection. The form the golden fixtures use, and
 * the form that makes "same machines, different document order → same output" a one-line
 * test.
 */
export function applyFilter(config: FilterConfig, machines: Iterable<RawMachine>): FilterResult {
  const accumulator = createFilter(config);
  for (const machine of machines) accumulator.add(machine);
  return accumulator.finish();
}

/**
 * Rebuilds a machine with `clone_count` in its DDL position — between `mame_manufacturer`
 * and `driver_status`. Key order in the emitted JSON is the schema's column order
 * (data-model.md §4.3), and an object spread would append the key at the end instead.
 */
function withCloneCount(machine: RawMachine, cloneCount: number): RawMachine {
  return {
    machine_id: machine.machine_id,
    name: machine.name,
    mame_sourcefile: machine.mame_sourcefile,
    ...(machine.mame_year !== undefined ? { mame_year: machine.mame_year } : {}),
    ...(machine.mame_manufacturer !== undefined
      ? { mame_manufacturer: machine.mame_manufacturer }
      : {}),
    clone_count: cloneCount,
    ...(machine.driver_status !== undefined ? { driver_status: machine.driver_status } : {}),
    is_bios: machine.is_bios,
    is_device: machine.is_device,
    is_mechanical: machine.is_mechanical,
    runnable: machine.runnable,
    ...(machine.cloneof !== undefined ? { cloneof: machine.cloneof } : {}),
    ...(machine.romof !== undefined ? { romof: machine.romof } : {}),
    devices: machine.devices,
  };
}
