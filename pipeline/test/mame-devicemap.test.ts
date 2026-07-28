/**
 * TASKS T3.2 — the unmapped-device worklist.
 *
 * Two claims need proving, and this file is split to match them:
 *
 * 1. `routeDevices` is a correct, deterministic, total function of any device map — the
 *    "pure function" tests below build their own fixtures and never read
 *    `data/mame_device/*.json`, so they stay correct while that file is curated
 *    concurrently and its contents change under this task.
 * 2. What `routeDevices` produces really does flow through to `machine_unmapped_device`
 *    and get counted by the *real* `v_mame_device_worklist` and
 *    `v_system_coverage_by_kind.unmapped_device_count` — the "the extract is already rows"
 *    describe block, which follows `mame/verify.ts`'s pattern of inserting into a database
 *    built from `schemas/schema.sql` rather than re-implementing what the views compute.
 */
import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';

import { createSchemaDatabase, checkIntegrity } from '../src/db/schema.js';
import type { RawMachine } from '../src/mame/parse.js';
import {
  deviceMapFromRows,
  routeDevices,
  type DeviceMap,
  type MachineChipRow,
  type MachineUnmappedDeviceRow,
} from '../src/mame/devicemap.js';

function machine(id: string, devices: RawMachine['devices']): RawMachine {
  return {
    machine_id: id,
    name: id,
    mame_sourcefile: 'test/driver.cpp',
    is_bios: 0,
    is_device: 0,
    is_mechanical: 0,
    runnable: 1,
    devices,
  };
}

describe('routeDevices — the routing decision, against a synthetic map', () => {
  const deviceMap: DeviceMap = new Map([
    ['testchip', { chipId: 'test-chip' }],
    ['palette', { ignoreReason: 'MAME-internal video palette device, not a chip.' }],
  ]);

  const machineA = machine('machinea', [
    { mame_tag: 'maincpu', mame_device: 'testchip', clock_hz: 4_000_000 },
    { mame_tag: 'pal', mame_device: 'palette' },
    { mame_tag: 'unk1', mame_device: 'mystery_dev' },
    { mame_tag: 'unk2', mame_device: 'mystery_dev' },
  ]);
  const machineB = machine('machineb', [{ mame_tag: 'sub', mame_device: 'mystery_dev' }]);

  it('routes a mapped device to one machine_chip row, clock included', () => {
    const { chips } = routeDevices([machineA, machineB], deviceMap);
    expect(chips).toEqual([
      { machine_id: 'machinea', mame_tag: 'maincpu', chip_id: 'test-chip', clock_hz: 4_000_000 },
    ]);
  });

  it('drops an ignored device entirely: no machine_chip row, no machine_unmapped_device row', () => {
    const { chips, unmapped } = routeDevices([machineA], deviceMap);
    expect(chips.some((row) => row.chip_id === 'palette')).toBe(false);
    expect(unmapped.some((row) => row.mame_device === 'palette')).toBe(false);
  });

  it('routes a device absent from the map to machine_unmapped_device, grouped with a quantity', () => {
    const { unmapped } = routeDevices([machineA, machineB], deviceMap);
    expect(unmapped).toEqual([
      { machine_id: 'machinea', mame_device: 'mystery_dev', quantity: 2 },
      { machine_id: 'machineb', mame_device: 'mystery_dev', quantity: 1 },
    ]);
  });

  it('is total: an entirely empty map still routes every device to unmapped, never to chips', () => {
    const { chips, unmapped } = routeDevices([machineA, machineB], new Map());
    expect(chips).toEqual([]);
    const byDevice = new Map(unmapped.map((row) => [`${row.machine_id}/${row.mame_device}`, row]));
    expect(byDevice.get('machinea/testchip')).toEqual({
      machine_id: 'machinea',
      mame_device: 'testchip',
      quantity: 1,
    });
    expect(byDevice.get('machinea/palette')).toEqual({
      machine_id: 'machinea',
      mame_device: 'palette',
      quantity: 1,
    });
  });

  it('is correct for a map that maps or ignores everything: nothing at all is unmapped', () => {
    const fullMap: DeviceMap = new Map([
      ['testchip', { chipId: 'test-chip' }],
      ['palette', { ignoreReason: 'not a chip' }],
      ['mystery_dev', { chipId: 'mystery-chip' }],
    ]);
    const { unmapped } = routeDevices([machineA, machineB], fullMap);
    expect(unmapped).toEqual([]);
  });

  it('produces byte-identical results regardless of machine or device order (standing rule 2)', () => {
    const forward = routeDevices([machineA, machineB], deviceMap);
    const reversedMachines = routeDevices([machineB, machineA], deviceMap);
    const reversedDevices = routeDevices(
      [
        { ...machineA, devices: [...machineA.devices].reverse() },
        { ...machineB, devices: [...machineB.devices].reverse() },
      ],
      deviceMap,
    );
    expect(reversedMachines).toEqual(forward);
    expect(reversedDevices).toEqual(forward);
  });
});

describe('deviceMapFromRows — the seam T6.1 uses to build a DeviceMap from loaded rows', () => {
  it('reads chip_id and ignore_reason rows into the two DeviceMapEntry shapes', () => {
    const map = deviceMapFromRows([
      { mame_device: 'z80', chip_id: 'z80' },
      { mame_device: 'screen', ignore_reason: 'video timing generator, not a chip' },
    ]);
    expect(map.get('z80')).toEqual({ chipId: 'z80' });
    expect(map.get('screen')).toEqual({ ignoreReason: 'video timing generator, not a chip' });
    expect(map.has('unheard-of')).toBe(false);
  });

  it('skips a malformed row rather than throwing, consistent with routeDevices never treating unrecognised input as fatal', () => {
    const map = deviceMapFromRows([{ mame_device: 'ghost' }]);
    expect(map.has('ghost')).toBe(false);
    expect(map.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The acceptance bar: proved against the real DDL and the real views, not a
// re-implementation of what they compute (mame/verify.ts's pattern).
// ---------------------------------------------------------------------------

function insertLookups(db: DatabaseSync): void {
  db.exec(`
    INSERT INTO chip_function (function_id, label, description, prospector_band)
      VALUES ('cpu', 'CPU', 'Executes an instruction stream.', 'medium');
    INSERT INTO chip (chip_id, display_name, function_id)
      VALUES ('test-chip', 'Test Chip', 'cpu');
    INSERT INTO system_kind (kind_id, label) VALUES ('arcade', 'Arcade');
    INSERT INTO system (system_id, name, kind_id) VALUES ('test-system', 'Test System', 'arcade');
    INSERT INTO system_driver (mame_sourcefile, system_id)
      VALUES ('test/driver.cpp', 'test-system');
    INSERT INTO implementation_kind (kind_id, label, description)
      VALUES ('fpga_hdl', 'FPGA HDL', 'Synthesizable hardware description.');
    -- The curated other half of the picture (T3.1's job, not this one): 'testchip' is
    -- mapped and 'palette' is ignored, so v_quality_device can show all three states at
    -- once. 'mystery_dev' deliberately gets no row here — that absence is what makes it
    -- unmapped, and inserting one for it would be the very "unknown:* stub" TB8 forbids.
    INSERT INTO mame_device (mame_device, chip_id) VALUES ('testchip', 'test-chip');
    INSERT INTO mame_device (mame_device, ignore_reason)
      VALUES ('palette', 'MAME-internal video palette device, not a chip.');
  `);
}

function insertMachines(db: DatabaseSync, machines: readonly RawMachine[]): void {
  const insert = db.prepare(
    `INSERT INTO machine (machine_id, name, mame_sourcefile, is_bios, is_device, is_mechanical)
     VALUES (:machine_id, :name, :mame_sourcefile, :is_bios, :is_device, :is_mechanical)`,
  );
  for (const m of machines) {
    insert.run({
      machine_id: m.machine_id,
      name: m.name,
      mame_sourcefile: m.mame_sourcefile,
      is_bios: m.is_bios,
      is_device: m.is_device,
      is_mechanical: m.is_mechanical,
    });
  }
}

function insertChips(db: DatabaseSync, rows: readonly MachineChipRow[]): void {
  const insert = db.prepare(
    `INSERT INTO machine_chip (machine_id, mame_tag, chip_id, clock_hz)
     VALUES (:machine_id, :mame_tag, :chip_id, :clock_hz)`,
  );
  for (const row of rows) {
    insert.run({
      machine_id: row.machine_id,
      mame_tag: row.mame_tag,
      chip_id: row.chip_id,
      clock_hz: row.clock_hz ?? null,
    });
  }
}

function insertUnmapped(db: DatabaseSync, rows: readonly MachineUnmappedDeviceRow[]): void {
  const insert = db.prepare(
    `INSERT INTO machine_unmapped_device (machine_id, mame_device, quantity)
     VALUES (:machine_id, :mame_device, :quantity)`,
  );
  for (const row of rows) {
    insert.run({
      machine_id: row.machine_id,
      mame_device: row.mame_device,
      quantity: row.quantity,
    });
  }
}

function rows(db: DatabaseSync, sql: string, params: Record<string, string> = {}): unknown[] {
  const statement = db.prepare(sql);
  return Object.keys(params).length === 0 ? statement.all() : statement.all(params);
}

describe('the extract is already rows: an unmapped device flows to the real views', () => {
  const deviceMap: DeviceMap = new Map([
    ['testchip', { chipId: 'test-chip' }],
    ['palette', { ignoreReason: 'MAME-internal video palette device, not a chip.' }],
  ]);
  const machineA = machine('machinea', [
    { mame_tag: 'maincpu', mame_device: 'testchip', clock_hz: 4_000_000 },
    { mame_tag: 'pal', mame_device: 'palette' },
    { mame_tag: 'unk1', mame_device: 'mystery_dev' },
    { mame_tag: 'unk2', mame_device: 'mystery_dev' },
  ]);
  const machineB = machine('machineb', [{ mame_tag: 'sub', mame_device: 'mystery_dev' }]);

  function buildDatabase(): DatabaseSync {
    const db = createSchemaDatabase();
    insertLookups(db);
    insertMachines(db, [machineA, machineB]);
    const routed = routeDevices([machineA, machineB], deviceMap);
    insertChips(db, routed.chips);
    insertUnmapped(db, routed.unmapped);
    return db;
  }

  it('loads with zero foreign_key_check / integrity_check violations', () => {
    const db = buildDatabase();
    expect(checkIntegrity(db)).toEqual([]);
    db.close();
  });

  it('mystery_dev has no mame_device row at all — the DDL never needed one', () => {
    // machine_unmapped_device.mame_device is deliberately not a foreign key (schema.sql):
    // this insert succeeded above with zero rows in `mame_device` for 'mystery_dev', which
    // is the point — an unmapped device is not a dangling reference to fix, it is the
    // state before a curator has acted.
    const db = buildDatabase();
    expect(rows(db, `SELECT * FROM mame_device WHERE mame_device = 'mystery_dev'`)).toEqual([]);
    db.close();
  });

  it('is counted in v_mame_device_worklist, the curation queue', () => {
    const db = buildDatabase();
    expect(
      rows(
        db,
        `SELECT mame_device, machine_count, instance_count FROM v_mame_device_worklist
         WHERE mame_device = 'mystery_dev'`,
      ),
    ).toEqual([{ mame_device: 'mystery_dev', machine_count: 2, instance_count: 3 }]);
    // Mapped and ignored devices never appear in the worklist: they are resolved.
    expect(
      rows(
        db,
        `SELECT mame_device FROM v_mame_device_worklist WHERE mame_device IN ('testchip', 'palette')`,
      ),
    ).toEqual([]);
    db.close();
  });

  it("is counted in v_system_coverage_by_kind.unmapped_device_count for the machine's system", () => {
    const db = buildDatabase();
    expect(
      rows(
        db,
        `SELECT unmapped_device_count FROM v_system_coverage_by_kind
         WHERE system_id = 'test-system' AND kind_id = 'fpga_hdl'`,
      ),
    ).toEqual([{ unmapped_device_count: 1 }]); // one *distinct* device, not one per instance
    db.close();
  });

  it('agrees with v_quality_device: one mapped, one ignored, one unmapped', () => {
    const db = buildDatabase();
    expect(
      rows(db, `SELECT devices_mapped, devices_ignored, devices_unmapped FROM v_quality_device`),
    ).toEqual([{ devices_mapped: 1, devices_ignored: 1, devices_unmapped: 1 }]);
    db.close();
  });
});
