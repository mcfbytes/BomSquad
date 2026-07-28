/**
 * TASKS T6.1 — the extraction, turned into row files.
 *
 * `pipeline mame:extract` leaves two `*.raw.json` intermediates behind (nested, one
 * machine per line, not row files). This module applies the curated `mame_device`
 * dictionary to `extract/machines.raw.json` and writes the four files data-model.md §4.2
 * names as pipeline-written:
 *
 * | file                                   | table                     |
 * | -------------------------------------- | ------------------------- |
 * | `extract/machine.json`                 | `machine`                 |
 * | `extract/machine_chip.json`            | `machine_chip`            |
 * | `extract/machine_unmapped_device.json` | `machine_unmapped_device` |
 * | `extract/dataset_meta.json`            | `dataset_meta`            |
 *
 * These **are** row files, so they are held to §4.3 exactly — DDL column order for keys,
 * primary-key order for rows, `NULL` columns omitted, two-space indent, one trailing
 * newline — which is why they are serialised by `canonicalRowFileJson`, the same function
 * `pipeline validate`'s `json-format` rule compares committed files against.
 *
 * ## Three things this deliberately does not do
 *
 * 1. **It applies no corrections.** `machine_correction`, `machine_system` and
 *    `machine_chip_correction` are *curated row files* whose targets are these rows; the
 *    views (`v_machine`, `v_machine_system`) and the one §5.1 pass inside the build apply
 *    them against the loaded database. Merging any of them into the files below would
 *    write curated judgement into a generated artifact that the next MAME bump silently
 *    overwrites — standing rule 1, and the reason `extract/` and `data/` are separate
 *    trees at all.
 * 2. **It does not decide anything about a device.** `mame/devicemap.ts` owns the
 *    mapped/ignored/unmapped routing and is proved against a synthetic map; this module
 *    hands it the real `mame_device` rows and writes down what comes back.
 * 3. **It knows no column names.** The `machine` row is the intersection of a
 *    {@link RawMachine}'s own keys with the table's columns, read from the live DDL —
 *    `parse.ts` shaped the record to be the table's columns already, so `runnable`,
 *    `cloneof` and `romof` fall out for the single honest reason that the DDL has no such
 *    columns, not because a list here says so.
 *
 * ## Where the device map is read from
 *
 * Every `mame_device` row under `data/`, wherever a curator put it (`data/mame_device.json`
 * today, `data/mame_device/*.json` if it is ever split), discovered with the same
 * `discoverRowFiles`/`readRowFile` pair the loader uses. Nothing here knows a path below
 * `data/`.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { TableInfo } from '../db/introspect.js';
import { canonicalRowFileJson, discoverRowFiles, readRowFile, type Row } from '../db/rowfiles.js';
import { deviceMapFromRows, routeDevices, type DeviceMap } from '../mame/devicemap.js';
import { MACHINES_FILE } from '../mame/extract.js';
import type { RawMachine } from '../mame/parse.js';

/** Table → file stem. §4.2's file map, which is one file per table for generated output. */
export const EXTRACT_ROW_FILES: readonly string[] = [
  'machine',
  'machine_chip',
  'machine_unmapped_device',
  'dataset_meta',
];

/** `extract/machines.raw.json`, parsed: the provenance header plus the machines. */
export interface RawExtract {
  readonly mameVersion: string;
  readonly machines: readonly RawMachine[];
}

/** One emitted file. */
export interface EmittedRowFile {
  /** Absolute path. */
  readonly path: string;
  readonly table: string;
  readonly rowCount: number;
  readonly bytes: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads `machines.raw.json`. The header's `mame_version` is MAME's own version string,
 * verbatim (versioning.md §3) — it becomes `dataset_meta.mame_version` unreinterpreted.
 */
export function readRawExtract(path: string): RawExtract {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isPlainObject(raw)) throw new Error(`${path}: expected a JSON object`);
  const mameVersion = raw['mame_version'];
  const machines = raw['machines'];
  if (typeof mameVersion !== 'string' || mameVersion === '') {
    throw new Error(`${path}: missing 'mame_version'`);
  }
  if (!Array.isArray(machines)) throw new Error(`${path}: 'machines' must be an array`);
  return { mameVersion, machines: machines as readonly RawMachine[] };
}

/**
 * Every `mame_device` row under `roots`, as the map {@link routeDevices} consumes.
 *
 * Read through the ordinary row-file reader rather than a bespoke parser: the dictionary
 * is curated data like any other, and a file that this could read but `pipeline validate`
 * could not would be a second, weaker definition of the same table.
 */
export function readDeviceMap(roots: readonly string[]): DeviceMap {
  const rows: Row[] = [];
  for (const path of discoverRowFiles(roots)) {
    const file = readRowFile(path);
    rows.push(...(file.tables.get('mame_device') ?? []));
  }
  return deviceMapFromRows(rows);
}

/**
 * The `machine` row for one extracted machine: every DDL column the record carries a
 * value for, in declaration order, with absent values absent rather than `null` (§4.3).
 */
function machineRow(machine: RawMachine, info: TableInfo): Row {
  const source = machine as unknown as Record<string, unknown>;
  const row: Record<string, string | number> = {};
  for (const column of info.columns) {
    const value = source[column.name];
    if (typeof value === 'string' || typeof value === 'number') row[column.name] = value;
  }
  return row;
}

/**
 * The whole T6.1 join, as tables. Pure: no I/O, no ordering assumptions about its input
 * (`canonicalRowFileJson` sorts by primary key on the way out), and no knowledge of what
 * any particular device maps to.
 */
export function buildExtractRows(
  extract: RawExtract,
  deviceMap: DeviceMap,
  schema: ReadonlyMap<string, TableInfo>,
): Map<string, Row[]> {
  const machineInfo = schema.get('machine');
  if (machineInfo === undefined) throw new Error("no 'machine' table in schemas/schema.sql");
  const routed = routeDevices(extract.machines, deviceMap);
  return new Map<string, Row[]>([
    ['machine', extract.machines.map((machine) => machineRow(machine, machineInfo))],
    ['machine_chip', routed.chips.map((row) => ({ ...row }))],
    ['machine_unmapped_device', routed.unmapped.map((row) => ({ ...row }))],
    ['dataset_meta', [{ key: 'mame_version', value: extract.mameVersion }]],
  ]);
}

/**
 * Writes one file per table into `outputDir`.
 *
 * A table with no rows produces **no file**, and deletes a stale one: `rowfile.schema.json`
 * declares `minItems: 1` for every table, so `{"machine_chip": []}` is not a valid row
 * file, and a file left behind from a previous run with different curation would be a
 * generated artifact nothing regenerates — exactly the rot standing rule 1 exists to
 * prevent.
 */
export function writeExtractRowFiles(
  outputDir: string,
  tables: ReadonlyMap<string, readonly Row[]>,
  schema: ReadonlyMap<string, TableInfo>,
): EmittedRowFile[] {
  const written: EmittedRowFile[] = [];
  for (const table of EXTRACT_ROW_FILES) {
    const rows = tables.get(table) ?? [];
    const path = join(outputDir, `${table}.json`);
    if (rows.length === 0) {
      rmSync(path, { force: true });
      continue;
    }
    const text = canonicalRowFileJson(new Map([[table, rows]]), schema);
    writeFileSync(path, text);
    written.push({ path, table, rowCount: rows.length, bytes: Buffer.byteLength(text, 'utf8') });
  }
  return written;
}

export interface EmitOptions {
  /** Where `machines.raw.json` is read from and the row files are written. */
  readonly extractDir: string;
  /** Roots scanned for `mame_device` rows. Normally just `data/`. */
  readonly dataRoots: readonly string[];
  readonly schema: ReadonlyMap<string, TableInfo>;
}

export interface EmitResult {
  readonly mameVersion: string;
  readonly machineCount: number;
  readonly mappedDeviceCount: number;
  readonly ignoredDeviceCount: number;
  readonly files: readonly EmittedRowFile[];
}

/** Reads the raw extract and the curated dictionary, and writes the four row files. */
export function emitExtractRowFiles(options: EmitOptions): EmitResult {
  const extract = readRawExtract(join(options.extractDir, MACHINES_FILE));
  const deviceMap = readDeviceMap(options.dataRoots);
  const tables = buildExtractRows(extract, deviceMap, options.schema);
  let ignored = 0;
  for (const entry of deviceMap.values()) if ('ignoreReason' in entry) ignored += 1;
  return {
    mameVersion: extract.mameVersion,
    machineCount: extract.machines.length,
    mappedDeviceCount: deviceMap.size - ignored,
    ignoredDeviceCount: ignored,
    files: writeExtractRowFiles(options.extractDir, tables, options.schema),
  };
}

/** The run log — row counts and file sizes, the two numbers a reviewer checks. */
export function formatEmitLog(result: EmitResult): string {
  const lines = [
    `mame:rows: MAME ${result.mameVersion} · ${result.machineCount} machines · ` +
      `${result.mappedDeviceCount} devices mapped, ${result.ignoredDeviceCount} ignored`,
  ];
  for (const file of result.files) {
    lines.push(
      `  wrote ${file.path} (${file.rowCount} ${file.table} rows, ` +
        `${(file.bytes / (1 << 20)).toFixed(2)} MiB)`,
    );
  }
  return `${lines.join('\n')}\n`;
}
