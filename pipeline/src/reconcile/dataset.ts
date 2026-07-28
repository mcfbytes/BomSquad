/**
 * The dataset as reconciliation needs to see it, and the MAME `-listxml` witness built
 * from it.
 *
 * ## Why this reads row files rather than the built database
 *
 * `dist/bomsquad.sqlite` would answer these questions in SQL, but it is a build artefact:
 * it may be absent, stale, or built from a different curation state than the one on disk.
 * Reconciliation compares *what the dataset currently says* against *what the world says*,
 * so it reads the same committed row files `pipeline build` reads and joins them the same
 * way `v_machine_system` does. That also means `pipeline reconcile` needs no build first,
 * which matters because it is the one command that needs the network.
 *
 * ## The one join that has to match the DDL
 *
 * A machine belongs to the system a `machine_system` row gives it; failing that, to the
 * system whose `system_driver` row names its `mame_sourcefile`; failing that, to none. That
 * is `v_machine_system`'s precedence sentence in `schemas/schema.sql`, restated here in
 * TypeScript rather than borrowed, because the alternative is opening a database. If the two
 * ever disagree the reconciliation report is wrong about which board a part is on, so
 * {@link resolveMachineSystems} is small and tested directly.
 *
 * ## What the MAME witness asserts
 *
 * Both the mapped and the unmapped halves, because the difference between them is a
 * finding rather than an implementation detail. A part in `machine_unmapped_device` is
 * something MAME *sees* and nobody has classified — it is already on the T3.2 worklist and
 * a reference witness naming it is confirmation, not news. A part in neither is something
 * MAME does not model at all, and that is the blind spot no single-source dataset can
 * detect. Folding the two together would erase exactly the distinction this task exists to
 * surface.
 */
import { join } from 'node:path';

import { compareBytes, discoverRowFiles, readRowFile, type Row } from '../db/rowfiles.js';
import { DATA_DIR, EXTRACT_DIR } from '../build/index.js';
import { collapseParts, type WitnessPart, type WitnessRecord } from './witness.js';
import { buildChipIndex, normalizeWithoutVendor, partKey, type ChipIndex } from './parts.js';
import type { RecognitionConfig } from './config.js';

/** Tables read out of `data/` and `extract/`. Everything else is skipped unparsed. */
const TABLES = [
  'chip',
  'chip_name',
  'machine',
  'machine_chip',
  'machine_system',
  'machine_unmapped_device',
  'system',
  'system_driver',
] as const;
type TableName = (typeof TABLES)[number];

export type LoadedTables = ReadonlyMap<TableName, readonly Row[]>;

/** Everything reconciliation needs from disk, already joined. */
export interface Dataset {
  /** `system_id` -> the system's `name`, bytewise sorted by id. */
  readonly systems: readonly { readonly systemId: string; readonly name: string }[];
  /** `system_id` -> its machines' ids, bytewise sorted. */
  readonly machinesBySystem: ReadonlyMap<string, readonly string[]>;
  /** `system_id` -> every driver source file its machines came from, bytewise sorted. */
  readonly sourcefilesBySystem: ReadonlyMap<string, readonly string[]>;
  /**
   * `mame_sourcefile` -> the systems whose `system_driver` row *declares* it, bytewise
   * sorted. This is a strictly stronger statement than {@link sourcefilesBySystem}: a file
   * reaches a system whenever one `machine_system` override points a single machine at it,
   * but it *declares* one only where the dataset says "this driver's default board is X".
   * `mame-source.ts` needs the difference — see the file-level attribution rule there.
   */
  readonly declaredSystemsBySourcefile: ReadonlyMap<string, readonly string[]>;
  /** `machine_id` -> its MAME driver source file. */
  readonly sourcefileByMachine: ReadonlyMap<string, string>;
  readonly chipIndex: ChipIndex;
  readonly tables: LoadedTables;
}

function stringField(row: Row, column: string): string | undefined {
  const value = row[column];
  return typeof value === 'string' ? value : undefined;
}

/** Reads every row file under `roots` once, keeping only {@link TABLES}. */
export function loadTables(roots: readonly string[]): LoadedTables {
  const wanted = new Set<string>(TABLES);
  const collected = new Map<TableName, Row[]>();
  for (const path of discoverRowFiles(roots)) {
    for (const [table, rows] of readRowFile(path).tables) {
      if (!wanted.has(table)) continue;
      const bucket = collected.get(table as TableName) ?? [];
      bucket.push(...rows);
      collected.set(table as TableName, bucket);
    }
  }
  return collected;
}

/**
 * `machine_id` -> `system_id`, applying `v_machine_system`'s precedence: an explicit
 * `machine_system` row wins over the `system_driver` rule for the machine's source file.
 *
 * A `machine_system` row naming a machine that is not in the extract is ignored rather
 * than thrown on — `pipeline validate` is what reports that, and it reports it better.
 */
export function resolveMachineSystems(
  machines: readonly Row[],
  systemDrivers: readonly Row[],
  machineSystems: readonly Row[],
): ReadonlyMap<string, string> {
  const bySourcefile = new Map<string, string>();
  for (const row of systemDrivers) {
    const sourcefile = stringField(row, 'mame_sourcefile');
    const systemId = stringField(row, 'system_id');
    if (sourcefile !== undefined && systemId !== undefined) bySourcefile.set(sourcefile, systemId);
  }
  const override = new Map<string, string>();
  for (const row of machineSystems) {
    const machineId = stringField(row, 'machine_id');
    const systemId = stringField(row, 'system_id');
    if (machineId !== undefined && systemId !== undefined) override.set(machineId, systemId);
  }

  const resolved = new Map<string, string>();
  for (const row of machines) {
    const machineId = stringField(row, 'machine_id');
    if (machineId === undefined) continue;
    const sourcefile = stringField(row, 'mame_sourcefile');
    const systemId =
      override.get(machineId) ??
      (sourcefile === undefined ? undefined : bySourcefile.get(sourcefile));
    if (systemId !== undefined) resolved.set(machineId, systemId);
  }
  return resolved;
}

/** Loads and joins `data/` and `extract/`. */
export function loadDataset(
  recognition: RecognitionConfig,
  roots: readonly string[] = [DATA_DIR, EXTRACT_DIR],
): Dataset {
  const tables = loadTables(roots);
  const rows = (table: TableName): readonly Row[] => tables.get(table) ?? [];

  const systems = rows('system')
    .flatMap((row) => {
      const systemId = stringField(row, 'system_id');
      return systemId === undefined
        ? []
        : [{ systemId, name: stringField(row, 'name') ?? systemId }];
    })
    .sort((a, b) => compareBytes(a.systemId, b.systemId));

  const machineSystem = resolveMachineSystems(
    rows('machine'),
    rows('system_driver'),
    rows('machine_system'),
  );

  const sourcefileByMachine = new Map<string, string>();
  for (const row of rows('machine')) {
    const machineId = stringField(row, 'machine_id');
    const sourcefile = stringField(row, 'mame_sourcefile');
    if (machineId !== undefined && sourcefile !== undefined) {
      sourcefileByMachine.set(machineId, sourcefile);
    }
  }

  const machinesBySystem = new Map<string, string[]>();
  const sourcefilesBySystem = new Map<string, Set<string>>();
  for (const [machineId, systemId] of machineSystem) {
    const machines = machinesBySystem.get(systemId) ?? [];
    machines.push(machineId);
    machinesBySystem.set(systemId, machines);
    const sourcefile = sourcefileByMachine.get(machineId);
    if (sourcefile === undefined) continue;
    const bucket = sourcefilesBySystem.get(systemId) ?? new Set<string>();
    bucket.add(sourcefile);
    sourcefilesBySystem.set(systemId, bucket);
  }
  for (const ids of machinesBySystem.values()) ids.sort(compareBytes);

  const declaredSystemsBySourcefile = new Map<string, string[]>();
  for (const row of rows('system_driver')) {
    const sourcefile = stringField(row, 'mame_sourcefile');
    const systemId = stringField(row, 'system_id');
    if (sourcefile === undefined || systemId === undefined) continue;
    const bucket = declaredSystemsBySourcefile.get(sourcefile) ?? [];
    bucket.push(systemId);
    declaredSystemsBySourcefile.set(sourcefile, bucket);
  }
  for (const ids of declaredSystemsBySourcefile.values()) ids.sort(compareBytes);

  return {
    systems,
    machinesBySystem,
    sourcefilesBySystem: new Map(
      [...sourcefilesBySystem].map(([systemId, files]) => [
        systemId,
        [...files].sort(compareBytes),
      ]),
    ),
    declaredSystemsBySourcefile,
    sourcefileByMachine,
    chipIndex: buildChipIndex(rows('chip'), rows('chip_name'), recognition),
    tables,
  };
}

/** One part accumulating across the machines of one system. */
interface AccumulatedPart {
  readonly part: Omit<WitnessPart, 'machine_count'>;
  readonly machines: Set<string>;
}

/** How a curator sees the MAME half of a claim: the pinned release's own XML. */
function listxmlSourceUrl(release: string): string {
  return `https://github.com/mamedev/mame/releases/tag/${release}`;
}

/**
 * The MAME `-listxml` witness for every system, from the committed extract row files.
 *
 * `machine_count` travels with each part because it is what makes a `mame-only` finding
 * triageable. A chip on 40 of 40 machines is the board; a chip on 1 of 40 is a bootleg's
 * substitution or a conversion kit, and no reference source was ever going to mention it.
 * Without the count every `mame-only` row reads the same and the report is noise.
 */
export function mameListxmlWitness(
  dataset: Dataset,
  release: string,
  recognition: RecognitionConfig,
): ReadonlyMap<string, WitnessRecord> {
  const rows = (table: TableName): readonly Row[] => dataset.tables.get(table) ?? [];
  const systemOf = new Map<string, string>();
  for (const [systemId, machineIds] of dataset.machinesBySystem) {
    for (const machineId of machineIds) systemOf.set(machineId, systemId);
  }

  /** `system_id` -> part key -> the accumulating assertion. */
  const perSystem = new Map<string, Map<string, AccumulatedPart>>();
  const record = (
    systemId: string,
    machineId: string,
    key: string,
    part: Omit<WitnessPart, 'machine_count'>,
  ): void => {
    const bucket = perSystem.get(systemId) ?? new Map<string, AccumulatedPart>();
    perSystem.set(systemId, bucket);
    const existing = bucket.get(key);
    if (existing === undefined) bucket.set(key, { part, machines: new Set([machineId]) });
    else existing.machines.add(machineId);
  };

  const url = listxmlSourceUrl(release);
  for (const row of rows('machine_chip')) {
    const machineId = stringField(row, 'machine_id');
    const chipId = stringField(row, 'chip_id');
    const tag = stringField(row, 'mame_tag') ?? '';
    if (machineId === undefined || chipId === undefined) continue;
    const systemId = systemOf.get(machineId);
    if (systemId === undefined) continue;
    record(systemId, machineId, `chip:${chipId}`, {
      key: `chip:${chipId}`,
      designation: chipId,
      chip_id: chipId,
      mame_state: 'mapped',
      source_url: url,
      evidence: `machine_chip ${machineId}:${tag} -> ${chipId}`,
    });
  }
  for (const row of rows('machine_unmapped_device')) {
    const machineId = stringField(row, 'machine_id');
    const device = stringField(row, 'mame_device');
    if (machineId === undefined || device === undefined) continue;
    const systemId = systemOf.get(machineId);
    if (systemId === undefined) continue;
    // An unmapped device is normalised through the same grammar every reference witness
    // uses, so `sega_315_5195` and a driver comment's `315-5195` land on one key and the
    // report says "MAME sees this, nobody has mapped it" rather than "nobody has it".
    const normalized = normalizeWithoutVendor(device, recognition.vendorPrefixes);
    const key = partKey(undefined, normalized);
    record(systemId, machineId, key, {
      key,
      designation: device,
      mame_state: 'unmapped',
      source_url: url,
      evidence: `machine_unmapped_device ${machineId} -> ${device}`,
    });
  }

  const witnesses = new Map<string, WitnessRecord>();
  for (const [systemId, bucket] of perSystem) {
    const parts = [...bucket.values()].map(({ part, machines }) => ({
      ...part,
      machine_count: machines.size,
    }));
    const collapsed = collapseParts('mame-listxml', parts);
    if (collapsed !== undefined) witnesses.set(systemId, collapsed);
  }
  return witnesses;
}

/** `extract/dataset_meta.json`'s `mame_version`, for the report header. */
export function readMameVersion(extractDir: string = EXTRACT_DIR): string | undefined {
  try {
    const file = readRowFile(join(extractDir, 'dataset_meta.json'));
    for (const row of file.tables.get('dataset_meta') ?? []) {
      if (stringField(row, 'key') === 'mame_version') return stringField(row, 'value');
    }
  } catch {
    return undefined;
  }
  return undefined;
}
