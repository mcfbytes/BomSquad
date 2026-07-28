/**
 * MAME `-listxml` → {@link RawMachine} records, one streaming pass, bounded memory.
 *
 * ## The record shape is the schema, pre-shaped
 *
 * Everything here is named and typed so that T6.1 can emit `machine`,
 * `machine_chip` and `machine_unmapped_device` row files by **selecting and grouping**,
 * never by reformatting a value:
 *
 * - `machine_id`, `name`, `mame_sourcefile`, `mame_year`, `mame_manufacturer`,
 *   `clone_count`, `driver_status`, `is_bios`, `is_device`, `is_mechanical` are the
 *   `machine` table's columns, in DDL order, already the right type — booleans as 0/1
 *   integers, not `true`/`false`; year and manufacturer as MAME's verbatim strings.
 * - An absent value is an **absent key**, never `null` (data-model.md §4.3).
 * - `clock_hz` is present only when MAME published a clock greater than zero, which is
 *   exactly `machine_chip.clock_hz`'s `CHECK (clock_hz > 0)`. MAME writes `clock="0"` for
 *   162 chips in 0.288; storing that as `0` would fail the insert, and storing it as a
 *   number MAME did not mean would be worse.
 * - `mame_tag` has its leading `:` stripped (data-model.md §1.3), so it is
 *   `machine_chip.mame_tag` verbatim.
 *
 * ## The join that makes the BOM usable
 *
 * MAME publishes the same device twice, differently:
 *
 * ```xml
 * <device_ref tag=":maincpu" name="z80"/>
 * <chip type="cpu" tag="maincpu" name="Zilog Z80" clock="3867120"/>
 * ```
 *
 * `device_ref/@name` is the device's **short name** — `[a-z0-9_]`, the key
 * `mame_device.mame_device` is declared over and the thing the chip catalog maps.
 * `chip/@name` is a **display name** for humans and joins to nothing. Only `<chip>`
 * carries the clock and the cpu/audio classification, and only `<device_ref>` carries the
 * lookup key, so neither element alone yields a BOM row. They are joined here on their
 * tag, which is the socket: verified across all 50,097 machines of 0.288, every `<chip>`
 * tag in a machine that survives the filter resolves to a `<device_ref>` in the same
 * machine (51,328 of 51,328).
 *
 * One device therefore produces one {@link RawDevice}, keyed by tag — which is also what
 * `ux_machine_chip_tag` requires, and is not the same as one entry per `<chip>` element:
 * 682 kept machines list a part as both `type="cpu"` and `type="audio"` (POKEY, the
 * SPG240 SoC). Those are one chip with two roles, not two chips in one socket, so
 * `chip_types` is a set.
 */
import { decodeEntities, parseAttributes, scanXml, streamXml, type XmlHandler } from './xml.js';
import { compareBytes } from '../db/rowfiles.js';
import type { Readable } from 'node:stream';

/** MAME's driver quality grades, the domain of `machine.driver_status`. */
const DRIVER_STATUS = ['good', 'imperfect', 'preliminary'] as const;
export type DriverStatus = (typeof DRIVER_STATUS)[number];

/** One device instance in one machine — one socket, one part. */
export interface RawDevice {
  /** MAME tag, leading `:` stripped. `machine_chip.mame_tag` verbatim. */
  readonly mame_tag: string;
  /** MAME device short name. `mame_device.mame_device` verbatim; the catalog's join key. */
  readonly mame_device: string;
  /** `<chip type>` values MAME published for this tag, bytewise sorted. Absent if no `<chip>`. */
  readonly chip_types?: readonly string[];
  /** `<chip name>` — MAME's display name, e.g. `Zilog Z80`. Curation input, joins to nothing. */
  readonly chip_name?: string;
  /** `<chip clock>` in Hz, present only when greater than zero. `machine_chip.clock_hz`. */
  readonly clock_hz?: number;
}

/** One MAME machine, shaped so T6.1 can select rows out of it without rewriting values. */
export interface RawMachine {
  readonly machine_id: string;
  readonly name: string;
  readonly mame_sourcefile: string;
  readonly mame_year?: string;
  readonly mame_manufacturer?: string;
  /** Set by the filter, not the parser: it is a count of rows the filter removed. */
  readonly clone_count?: number;
  readonly driver_status?: DriverStatus;
  readonly is_bios: 0 | 1;
  readonly is_device: 0 | 1;
  readonly is_mechanical: 0 | 1;
  /** MAME vocabulary with no `machine` column: `runnable="no"` marks a device, not hardware. */
  readonly runnable: 0 | 1;
  /** Parent set this is a clone of. Present only on clones, which the default filter drops. */
  readonly cloneof?: string;
  /** Set this shares ROMs with. Not the same as `cloneof`: BIOS parents appear here only. */
  readonly romof?: string;
  /** Every device reference, bytewise sorted by tag. */
  readonly devices: readonly RawDevice[];
}

/** Counters that make an anomaly in a new MAME release visible instead of silent. */
export interface ParseStats {
  /** `<mame build>`, e.g. `0.288 (mame0288)`. The document's own claim about its version. */
  readonly build: string;
  readonly machines: number;
  readonly chips: number;
  readonly deviceRefs: number;
  /**
   * `<chip>` elements whose tag matched no `<device_ref>` in the same machine. There is no
   * short name for them and therefore no key to record them under, so they are dropped.
   * Zero for every machine that survives the filter in 0.288; a non-zero count here means
   * MAME changed how it emits device references and this join needs revisiting.
   */
  readonly chipsWithoutDeviceRef: number;
  /** `clock` absent, zero, or not a plain integer — omitted rather than coerced. */
  readonly chipsWithoutUsableClock: number;
  /** `<device_ref>` or `<chip>` with an empty tag once the leading `:` is stripped. */
  readonly untaggedReferences: number;
}

interface MutableStats {
  build: string;
  machines: number;
  chips: number;
  deviceRefs: number;
  chipsWithoutDeviceRef: number;
  chipsWithoutUsableClock: number;
  untaggedReferences: number;
}

/** What `<chip>` adds to a device once the two are joined on their tag. */
interface ChipFacts {
  readonly types: Set<string>;
  name: string | undefined;
  clockHz: number | undefined;
}

/** MAME tags are absolute on `<device_ref>` and relative on `<chip>`; normalise to relative. */
export function stripTagPrefix(tag: string): string {
  return tag.startsWith(':') ? tag.slice(1) : tag;
}

/** `yes` → 1, anything else (including absent) → 0. MAME only ever writes `yes` or `no`. */
function flag(value: string | undefined): 0 | 1 {
  return value === 'yes' ? 1 : 0;
}

function isDriverStatus(value: string | undefined): value is DriverStatus {
  return DRIVER_STATUS.includes(value as DriverStatus);
}

/**
 * A clock in Hz, or `undefined` when MAME's value cannot be one. Zero is rejected on
 * purpose: `machine_chip.clock_hz` is `CHECK (clock_hz IS NULL OR clock_hz > 0)`, so a
 * zero here would either fail T6.1's insert or have to be scrubbed there instead.
 */
export function parseClock(value: string | undefined): number | undefined {
  if (value === undefined || !/^[0-9]+$/.test(value)) return undefined;
  const clock = Number(value);
  return clock > 0 && Number.isSafeInteger(clock) ? clock : undefined;
}

/** Text elements whose character data is a `machine` column. */
const TEXT_COLUMNS = new Set(['description', 'year', 'manufacturer']);

/**
 * Builds a handler that assembles machines and hands each finished one to `onMachine`.
 *
 * Exported so the same assembly logic serves the streaming run and the string-based
 * golden fixtures — a golden test that exercised a parallel implementation would prove
 * nothing about the parser that reads the real file.
 */
export function createMachineHandler(
  onMachine: (machine: RawMachine) => void,
  stats: MutableStats,
): XmlHandler {
  /** Tag → short name, from `<device_ref>`. Reset per machine. */
  let deviceRefs = new Map<string, string>();
  /** Tag → what `<chip>` says about it. Reset per machine. */
  let chips = new Map<string, ChipFacts>();
  let attributes = new Map<string, string>();
  let description = '';
  let year: string | undefined;
  let manufacturer: string | undefined;
  let driverStatus: DriverStatus | undefined;
  let inMachine = false;
  let textTarget: string | undefined;

  const reset = (): void => {
    deviceRefs = new Map();
    chips = new Map();
    description = '';
    year = undefined;
    manufacturer = undefined;
    driverStatus = undefined;
    textTarget = undefined;
  };

  const finish = (): void => {
    if (!inMachine) return;
    inMachine = false;
    const machineId = attributes.get('name');
    if (machineId === undefined) {
      reset();
      return;
    }
    const devices: RawDevice[] = [];
    for (const [tag, mameDevice] of deviceRefs) {
      const facts = chips.get(tag);
      devices.push({
        mame_tag: tag,
        mame_device: mameDevice,
        ...(facts !== undefined && facts.types.size > 0
          ? { chip_types: [...facts.types].sort(compareBytes) }
          : {}),
        ...(facts?.name !== undefined ? { chip_name: facts.name } : {}),
        ...(facts?.clockHz !== undefined ? { clock_hz: facts.clockHz } : {}),
      });
    }
    for (const tag of chips.keys()) {
      if (!deviceRefs.has(tag)) stats.chipsWithoutDeviceRef += 1;
    }
    devices.sort((a, b) => compareBytes(a.mame_tag, b.mame_tag));

    const cloneof = attributes.get('cloneof');
    const romof = attributes.get('romof');
    stats.machines += 1;
    onMachine({
      machine_id: machineId,
      name: description,
      mame_sourcefile: attributes.get('sourcefile') ?? '',
      ...(year !== undefined ? { mame_year: year } : {}),
      ...(manufacturer !== undefined ? { mame_manufacturer: manufacturer } : {}),
      ...(driverStatus !== undefined ? { driver_status: driverStatus } : {}),
      is_bios: flag(attributes.get('isbios')),
      is_device: flag(attributes.get('isdevice')),
      is_mechanical: flag(attributes.get('ismechanical')),
      // The DTD defaults `runnable` to "yes"; MAME writes it only to say "no".
      runnable: attributes.get('runnable') === 'no' ? 0 : 1,
      ...(cloneof !== undefined ? { cloneof } : {}),
      ...(romof !== undefined ? { romof } : {}),
      devices,
    });
    reset();
  };

  return {
    onOpen(name, source, start, end, selfClosing): void {
      switch (name) {
        case 'machine': {
          finish();
          attributes = parseAttributes(source.slice(start, end));
          reset();
          inMachine = true;
          if (selfClosing) finish();
          return;
        }
        case 'mame': {
          stats.build = parseAttributes(source.slice(start, end)).get('build') ?? '';
          return;
        }
        default:
          break;
      }
      if (!inMachine) return;
      switch (name) {
        case 'device_ref': {
          const parsed = parseAttributes(source.slice(start, end));
          const tag = stripTagPrefix(parsed.get('tag') ?? '');
          const device = parsed.get('name');
          stats.deviceRefs += 1;
          if (tag === '' || device === undefined) {
            stats.untaggedReferences += 1;
            return;
          }
          deviceRefs.set(tag, device);
          return;
        }
        case 'chip': {
          const parsed = parseAttributes(source.slice(start, end));
          const tag = stripTagPrefix(parsed.get('tag') ?? '');
          stats.chips += 1;
          if (tag === '') {
            stats.untaggedReferences += 1;
            return;
          }
          const facts = chips.get(tag) ?? {
            types: new Set<string>(),
            name: undefined,
            clockHz: undefined,
          };
          const type = parsed.get('type');
          if (type !== undefined) facts.types.add(type);
          facts.name ??= parsed.get('name');
          const clock = parseClock(parsed.get('clock'));
          if (clock === undefined) stats.chipsWithoutUsableClock += 1;
          else facts.clockHz ??= clock;
          chips.set(tag, facts);
          return;
        }
        case 'driver': {
          const status = parseAttributes(source.slice(start, end)).get('status');
          if (isDriverStatus(status)) driverStatus = status;
          return;
        }
        default:
          if (TEXT_COLUMNS.has(name) && !selfClosing) textTarget = name;
          return;
      }
    },

    onClose(name): void {
      if (name === 'machine') finish();
      else if (name === textTarget) textTarget = undefined;
    },

    onText(source, start, end): void {
      if (textTarget === undefined) return;
      // The scanner reports one whole text run per node, so this assigns rather than
      // appends; `<description>` never arrives in pieces.
      const value = decodeText(source, start, end);
      if (textTarget === 'description') description = value;
      else if (textTarget === 'year') year = value;
      else manufacturer = value;
    },
  };
}

/** Slices and decodes a text run. Split out so the handler reads as dispatch, not string work. */
function decodeText(source: string, start: number, end: number): string {
  return decodeEntities(source.slice(start, end));
}

function emptyStats(): MutableStats {
  return {
    build: '',
    machines: 0,
    chips: 0,
    deviceRefs: 0,
    chipsWithoutDeviceRef: 0,
    chipsWithoutUsableClock: 0,
    untaggedReferences: 0,
  };
}

/** Parses a whole listxml document held in memory. For fixtures and tests. */
export function parseMachinesFromString(
  xml: string,
  onMachine: (machine: RawMachine) => void,
): ParseStats {
  const stats = emptyStats();
  scanXml(xml, true, createMachineHandler(onMachine, stats));
  return stats;
}

/**
 * Parses a listxml byte stream, calling `onMachine` once per `</machine>`.
 *
 * Nothing is accumulated here: peak memory is one read chunk plus one machine's devices,
 * and whatever the caller chooses to retain. That is what keeps the full 309 MB document
 * inside the RSS budget of TASKS T2.2.
 */
export async function parseMachines(
  source: Readable,
  onMachine: (machine: RawMachine) => void,
): Promise<ParseStats> {
  const stats = emptyStats();
  await streamXml(source, createMachineHandler(onMachine, stats));
  return stats;
}
