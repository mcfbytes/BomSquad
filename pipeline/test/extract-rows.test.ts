/**
 * TASKS T6.1 — the extraction, turned into row files.
 *
 * Three claims, and the tests are grouped to match them:
 *
 * 1. The **projection** is right: a `machine` row is the DDL's columns and only those,
 *    in declaration order, with absent values absent rather than `null`.
 * 2. The output is **canonical and deterministic** — byte-identical from reordered input,
 *    and accepted unchanged by the very lint rules `pipeline validate` applies to a
 *    committed row file. That second half is the one that matters: an emitter proved only
 *    against its own idea of canonical form proves nothing.
 * 3. **Corrections are not applied here.** A dataset carrying all three correction tables
 *    produces byte-identical output to one carrying none, and the corrected values appear
 *    only through the views, in the database.
 *
 * Nothing here reads the real `data/` tree or the real `extract/`: `data/mame_device.json`
 * is under active curation and its contents change daily, so every fixture below is built
 * in a temporary directory.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSchemaDatabase, checkIntegrity } from '../src/db/schema.js';
import { describeTables } from '../src/db/introspect.js';
import { loadDataset } from '../src/db/load.js';
import { canonicalRowFileJson, readRowFile, type Row } from '../src/db/rowfiles.js';
import { writeRecordArrayFile } from '../src/mame/json.js';
import { MACHINES_FILE } from '../src/mame/extract.js';
import type { RawMachine } from '../src/mame/parse.js';
import {
  buildExtractRows,
  emitExtractRowFiles,
  readDeviceMap,
  readRawExtract,
  writeExtractRowFiles,
} from '../src/build/extract-rows.js';
import { canonicalJson, lintFile, type Schema, type SourceFile } from '../src/validate/rules.js';

function liveSchema(): Schema {
  const db = createSchemaDatabase();
  const schema: Schema = new Map(describeTables(db).map((info) => [info.name, info]));
  db.close();
  return schema;
}

const SCHEMA = liveSchema();

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'bomsquad-t61-'));
}

function machine(id: string, devices: RawMachine['devices'], extra: Partial<RawMachine> = {}) {
  return {
    machine_id: id,
    name: `Machine ${id}`,
    mame_sourcefile: 'fx/test.cpp',
    is_bios: 0,
    is_device: 0,
    is_mechanical: 0,
    runnable: 1,
    ...extra,
    devices,
  } as RawMachine;
}

/** A `data/` tree holding just enough for the emitted rows to have parents. */
function writeCuratedData(dir: string, deviceRows: readonly Row[]): string {
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, 'lookup.json'),
    canonicalRowFileJson(
      new Map([
        [
          'chip_function',
          [
            {
              function_id: 'cpu',
              label: 'CPU',
              description: 'Executes an instruction stream.',
              prospector_band: 'medium',
            },
          ],
        ],
      ]),
      SCHEMA,
    ),
  );
  writeFileSync(
    join(dataDir, 'chip.json'),
    canonicalRowFileJson(
      new Map([
        [
          'chip',
          [
            { chip_id: 'z80', display_name: 'Z80', function_id: 'cpu' },
            { chip_id: 'ym2151', display_name: 'YM2151', function_id: 'cpu' },
          ],
        ],
      ]),
      SCHEMA,
    ),
  );
  writeFileSync(
    join(dataDir, 'mame_device.json'),
    canonicalRowFileJson(new Map([['mame_device', deviceRows]]), SCHEMA),
  );
  return dataDir;
}

/** `extract/machines.raw.json`, written by the real emitter `mame:extract` uses. */
function writeRawExtract(dir: string, machines: readonly RawMachine[], version = '0.288'): string {
  const extractDir = join(dir, 'extract');
  mkdirSync(extractDir, { recursive: true });
  writeRecordArrayFile(
    join(extractDir, MACHINES_FILE),
    { mame_version: version, machine_count: machines.length },
    'machines',
    machines,
  );
  return extractDir;
}

const DEVICE_ROWS: readonly Row[] = [
  { mame_device: 'z80', chip_id: 'z80' },
  { mame_device: 'ym2151', chip_id: 'ym2151' },
  { mame_device: 'screen', ignore_reason: 'MAME-internal video output, not a chip.' },
];

const MACHINES: readonly RawMachine[] = [
  machine(
    'beta',
    [
      { mame_tag: 'maincpu', mame_device: 'z80', clock_hz: 4000000 },
      { mame_tag: 'screen', mame_device: 'screen' },
      { mame_tag: 'gate', mame_device: 'fx_gate_array' },
      { mame_tag: 'gate2', mame_device: 'fx_gate_array' },
    ],
    { mame_year: '1987', mame_manufacturer: 'Fixture', clone_count: 3, driver_status: 'good' },
  ),
  machine('alpha', [
    { mame_tag: 'ymsnd', mame_device: 'ym2151' },
    { mame_tag: 'maincpu', mame_device: 'z80', clock_hz: 3579545 },
  ]),
];

describe('the machine projection is the DDL, not a hand-written column list', () => {
  it('keeps every machine column, in declaration order, and nothing else', () => {
    const rows = buildExtractRows(
      { mameVersion: '0.288', machines: MACHINES },
      new Map(),
      SCHEMA,
    ).get('machine');
    const beta = rows?.find((row) => row['machine_id'] === 'beta');
    expect(Object.keys(beta ?? {})).toEqual([
      'machine_id',
      'name',
      'mame_sourcefile',
      'mame_year',
      'mame_manufacturer',
      'clone_count',
      'driver_status',
      'is_bios',
      'is_device',
      'is_mechanical',
    ]);
  });

  it("drops MAME vocabulary the table has no column for — 'runnable', 'cloneof', 'romof'", () => {
    const rows = buildExtractRows(
      {
        mameVersion: '0.288',
        machines: [machine('gamma', [], { cloneof: 'alpha', romof: 'alpha' })],
      },
      new Map(),
      SCHEMA,
    ).get('machine');
    expect(Object.keys(rows?.[0] ?? {})).toEqual([
      'machine_id',
      'name',
      'mame_sourcefile',
      'is_bios',
      'is_device',
      'is_mechanical',
    ]);
  });

  it('omits an absent value rather than writing null (§4.3)', () => {
    const rows = buildExtractRows(
      { mameVersion: '0.288', machines: [machine('alpha', [])] },
      new Map(),
      SCHEMA,
    ).get('machine');
    expect(rows?.[0]).not.toHaveProperty('mame_year');
    expect(JSON.stringify(rows?.[0])).not.toContain('null');
  });

  it('carries the MAME version verbatim into the dataset_meta row', () => {
    const rows = buildExtractRows({ mameVersion: '0.288', machines: [] }, new Map(), SCHEMA).get(
      'dataset_meta',
    );
    expect(rows).toEqual([{ key: 'mame_version', value: '0.288' }]);
  });
});

describe('the emitted files are canonical and deterministic', () => {
  it('writes the four files of data-model.md §4.2', () => {
    const dir = scratch();
    const dataDir = writeCuratedData(dir, DEVICE_ROWS);
    const extractDir = writeRawExtract(dir, MACHINES);
    const result = emitExtractRowFiles({ extractDir, dataRoots: [dataDir], schema: SCHEMA });
    expect(result.files.map((file) => file.table)).toEqual([
      'machine',
      'machine_chip',
      'machine_unmapped_device',
      'dataset_meta',
    ]);
    expect(result.mappedDeviceCount).toBe(2);
    expect(result.ignoredDeviceCount).toBe(1);
  });

  it('produces byte-identical output from reordered input', () => {
    const forward = scratch();
    const reversed = scratch();
    const data = writeCuratedData(forward, DEVICE_ROWS);
    emitExtractRowFiles({
      extractDir: writeRawExtract(forward, MACHINES),
      dataRoots: [data],
      schema: SCHEMA,
    });
    emitExtractRowFiles({
      extractDir: writeRawExtract(
        reversed,
        [...MACHINES].reverse().map((m) => ({ ...m, devices: [...m.devices].reverse() })),
      ),
      dataRoots: [writeCuratedData(reversed, [...DEVICE_ROWS].reverse())],
      schema: SCHEMA,
    });
    for (const name of ['machine.json', 'machine_chip.json', 'machine_unmapped_device.json']) {
      expect(readFileSync(join(reversed, 'extract', name), 'utf8')).toBe(
        readFileSync(join(forward, 'extract', name), 'utf8'),
      );
    }
  });

  it('passes the canonical-form lint rules pipeline validate applies to committed files', () => {
    const dir = scratch();
    const extractDir = writeRawExtract(dir, MACHINES);
    emitExtractRowFiles({
      extractDir,
      dataRoots: [writeCuratedData(dir, DEVICE_ROWS)],
      schema: SCHEMA,
    });
    for (const name of [
      'machine.json',
      'machine_chip.json',
      'machine_unmapped_device.json',
      'dataset_meta.json',
    ]) {
      const path = join(extractDir, name);
      const text = readFileSync(path, 'utf8');
      const source: SourceFile = {
        path,
        relativePath: `extract/${name}`,
        text,
        tables: readRowFile(path).tables,
      };
      expect(lintFile(source, SCHEMA).filter((d) => d.severity === 'ERROR')).toEqual([]);
      expect(canonicalJson(source, SCHEMA)).toBe(text);
      expect(text.endsWith('}\n')).toBe(true);
    }
  });

  it('groups unmapped devices per machine with quantity as the instance count', () => {
    const dir = scratch();
    const extractDir = writeRawExtract(dir, MACHINES);
    emitExtractRowFiles({
      extractDir,
      dataRoots: [writeCuratedData(dir, DEVICE_ROWS)],
      schema: SCHEMA,
    });
    const rows = readRowFile(join(extractDir, 'machine_unmapped_device.json')).tables.get(
      'machine_unmapped_device',
    );
    // 'screen' is curated-ignored, so it appears nowhere; 'fx_gate_array' appears twice
    // in one machine, so it is one row of quantity 2.
    expect(rows).toEqual([{ machine_id: 'beta', mame_device: 'fx_gate_array', quantity: 2 }]);
  });

  it('writes no file for an empty table, and removes a stale one', () => {
    const dir = scratch();
    const extractDir = join(dir, 'extract');
    mkdirSync(extractDir, { recursive: true });
    const stale = join(extractDir, 'machine_chip.json');
    writeFileSync(stale, '{"machine_chip": []}\n');
    const written = writeExtractRowFiles(
      extractDir,
      new Map([['machine', [{ machine_id: 'a', name: 'A', mame_sourcefile: 'a/a.cpp' }]]]),
      SCHEMA,
    );
    expect(written.map((file) => file.table)).toEqual(['machine']);
    expect(existsSync(stale)).toBe(false);
  });
});

describe('the device map is read as curated row files, from anywhere under data/', () => {
  it('collects mame_device rows regardless of which file holds them', () => {
    const dir = scratch();
    const dataDir = join(dir, 'data', 'mame_device');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(dataDir, 'cpu.json'),
      canonicalRowFileJson(
        new Map([['mame_device', [{ mame_device: 'z80', chip_id: 'z80' }]]]),
        SCHEMA,
      ),
    );
    writeFileSync(
      join(dataDir, 'video.json'),
      canonicalRowFileJson(
        new Map([['mame_device', [{ mame_device: 'screen', ignore_reason: 'Not a chip.' }]]]),
        SCHEMA,
      ),
    );
    const map = readDeviceMap([join(dir, 'data')]);
    expect(map.get('z80')).toEqual({ chipId: 'z80' });
    expect(map.get('screen')).toEqual({ ignoreReason: 'Not a chip.' });
    expect(map.has('fx_gate_array')).toBe(false);
  });
});

describe('the emitted rows load into the real schema with no dangling references', () => {
  it('produces zero PRAGMA foreign_key_check violations alongside curated data', () => {
    const dir = scratch();
    const dataDir = writeCuratedData(dir, DEVICE_ROWS);
    const extractDir = writeRawExtract(dir, MACHINES);
    emitExtractRowFiles({ extractDir, dataRoots: [dataDir], schema: SCHEMA });
    const db = createSchemaDatabase();
    loadDataset(db, [dataDir, extractDir]);
    expect(checkIntegrity(db)).toEqual([]);
    db.close();
  });
});

describe('corrections are curated rows applied by view, never merged into extract/', () => {
  /** The same dataset, with every correction table populated against `alpha`. */
  function withCorrections(dir: string): string {
    const dataDir = writeCuratedData(dir, DEVICE_ROWS);
    writeFileSync(
      join(dataDir, 'system.json'),
      canonicalRowFileJson(
        new Map([
          ['system_kind', [{ kind_id: 'arcade', label: 'Arcade' }]],
          ['system', [{ system_id: 'fx-board', name: 'FX Board', kind_id: 'arcade' }]],
        ]),
        SCHEMA,
      ),
    );
    writeFileSync(
      join(dataDir, 'correction.json'),
      canonicalRowFileJson(
        new Map([
          [
            'machine_correction',
            [{ machine_id: 'alpha', name: 'Corrected Alpha', reason: 'Fixture correction.' }],
          ],
          ['machine_system', [{ machine_id: 'alpha', system_id: 'fx-board' }]],
          [
            'machine_chip_correction',
            [
              {
                machine_id: 'alpha',
                mame_tag: 'maincpu',
                chip_id: 'z80',
                op: 'set',
                clock_hz: 4000000,
                reason: 'Fixture correction.',
              },
            ],
          ],
        ]),
        SCHEMA,
      ),
    );
    return dataDir;
  }

  it('emits byte-identical files whether or not corrections exist', () => {
    const plain = scratch();
    const corrected = scratch();
    emitExtractRowFiles({
      extractDir: writeRawExtract(plain, MACHINES),
      dataRoots: [writeCuratedData(plain, DEVICE_ROWS)],
      schema: SCHEMA,
    });
    emitExtractRowFiles({
      extractDir: writeRawExtract(corrected, MACHINES),
      dataRoots: [withCorrections(corrected)],
      schema: SCHEMA,
    });
    for (const name of ['machine.json', 'machine_chip.json', 'machine_unmapped_device.json']) {
      expect(readFileSync(join(corrected, 'extract', name), 'utf8')).toBe(
        readFileSync(join(plain, 'extract', name), 'utf8'),
      );
    }
  });

  it('leaves the corrected values to v_machine and v_machine_system, in the database', () => {
    const dir = scratch();
    const dataDir = withCorrections(dir);
    const extractDir = writeRawExtract(dir, MACHINES);
    emitExtractRowFiles({ extractDir, dataRoots: [dataDir], schema: SCHEMA });

    // The generated file still says what MAME says.
    const machines = readRowFile(join(extractDir, 'machine.json')).tables.get('machine');
    expect(machines?.find((row) => row['machine_id'] === 'alpha')?.['name']).toBe('Machine alpha');

    const db = createSchemaDatabase();
    loadDataset(db, [dataDir, extractDir]);
    expect(db.prepare("SELECT name FROM machine WHERE machine_id = 'alpha'").get()).toEqual({
      name: 'Machine alpha',
    });
    expect(
      db.prepare("SELECT name, system_id FROM v_machine WHERE machine_id = 'alpha'").get(),
    ).toEqual({ name: 'Corrected Alpha', system_id: 'fx-board' });
    db.close();
  });
});

describe('reading the raw extract', () => {
  it('rejects a file with no mame_version rather than inventing one', () => {
    const dir = scratch();
    const path = join(dir, 'machines.raw.json');
    writeFileSync(path, '{"machines": []}\n');
    expect(() => readRawExtract(path)).toThrow(/mame_version/);
  });

  it("rejects a file whose 'machines' is not an array", () => {
    const dir = scratch();
    const path = join(dir, 'machines.raw.json');
    writeFileSync(path, '{"mame_version": "0.288", "machines": {}}\n');
    expect(() => readRawExtract(path)).toThrow(/machines/);
  });
});
