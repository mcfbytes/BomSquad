/**
 * The DDL is the integrity layer, so every constraint it declares is exercised here.
 * A constraint that has never rejected anything is a constraint you do not have.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';

import { DatabaseSync as Database } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  applySchema,
  checkIntegrity,
  createSchemaDatabase,
  readSchemaSql,
  SCHEMA_USER_VERSION,
  SCHEMAS_DIR,
} from '../src/db/schema.js';
import {
  describeTable,
  describeTables,
  listIndexes,
  listTables,
  listViews,
} from '../src/db/introspect.js';

const TABLES = [
  'accuracy_level',
  'chip',
  'chip_datasheet',
  'chip_equivalence',
  'chip_family',
  'chip_function',
  'chip_name',
  'chip_role',
  'dataset_meta',
  'fpga_platform',
  'hdl_language',
  'implementation',
  'implementation_chip',
  'implementation_dependency',
  'implementation_kind',
  'implementation_machine',
  'implementation_path',
  'implementation_platform',
  'implementation_system',
  'license',
  'machine',
  'machine_chip',
  'machine_chip_correction',
  'machine_correction',
  'machine_system',
  'machine_unmapped_device',
  'mame_device',
  'manufacturer',
  'manufacturer_alias',
  'project',
  'system',
  'system_chip',
  'system_driver',
  'system_kind',
  'system_name',
  'threshold',
].sort();

const VIEWS = [
  // data-model.md Appendix B
  'v_chip_gap',
  'v_chip_implementation_count',
  'v_chip_satisfies',
  'v_machine',
  'v_machine_bom',
  'v_machine_system',
  'v_mame_device_worklist',
  'v_prospector',
  'v_system_chip_effective',
  'v_system_core',
  'v_system_unmapped',
  // coverage.md §3.4
  'v_chip_evidence',
  'v_chip_satisfied',
  'v_system_chip_coverage',
  'v_system_coverage_by_kind',
  // data-quality.md Appendix Q
  'v_machine_instance',
  'v_quality_completeness',
  'v_quality_device',
  'v_quality_instance',
  'v_quality_warning',
  'v_system_instance',
].sort();

const INDEXES = [
  'ix_chip_equivalence_to',
  'ix_chip_family',
  'ix_chip_family_manufacturer',
  'ix_chip_function',
  'ix_chip_manufacturer',
  'ix_implementation_accuracy',
  'ix_implementation_chip_chip',
  'ix_implementation_dependency_provider',
  'ix_implementation_hdl_language',
  'ix_implementation_kind',
  'ix_implementation_license',
  'ix_implementation_machine_machine',
  'ix_implementation_platform_platform',
  'ix_implementation_project',
  'ix_implementation_system_system',
  'ix_machine_chip_chip',
  'ix_machine_chip_correction_chip',
  'ix_machine_correction_manufacturer',
  'ix_machine_sourcefile',
  'ix_machine_system_system',
  'ix_machine_unmapped_device',
  'ix_mame_device_chip',
  'ix_manufacturer_alias_manufacturer',
  'ix_system_chip_chip',
  'ix_system_chip_role',
  'ix_system_driver_system',
  'ix_system_kind',
  'ix_system_manufacturer',
  'ux_chip_equivalence_pair',
  'ux_chip_name_name',
  'ux_implementation_path_top',
  'ux_machine_chip_correction_tag',
  'ux_machine_chip_tag',
  'ux_system_name_name',
].sort();

/** Enough parent rows that every negative test below can name a real foreign key. */
const SEED = `
INSERT INTO chip_function VALUES ('cpu', 'CPU', 'Executes an instruction stream.', 'medium');
INSERT INTO manufacturer (manufacturer_id, name, country) VALUES ('zilog', 'Zilog', 'US');
INSERT INTO chip (chip_id, display_name, function_id) VALUES
  ('m68000', 'MC68000', 'cpu'), ('m68010', 'MC68010', 'cpu'), ('z80', 'Z80', 'cpu');
INSERT INTO system_kind VALUES ('arcade', 'Arcade');
INSERT INTO chip_role (role_id, label) VALUES ('maincpu', 'Main CPU');
INSERT INTO system (system_id, name, kind_id) VALUES ('sega-system16a', 'Sega System 16A', 'arcade');
INSERT INTO implementation_kind VALUES ('fpga_hdl', 'FPGA HDL', 'Synthesizable HDL.');
INSERT INTO implementation (implementation_id, name, kind_id) VALUES
  ('jt51', 'JT51', 'fpga_hdl'), ('t80', 'T80', 'fpga_hdl');
INSERT INTO machine (machine_id, name, mame_sourcefile, is_bios, is_device, is_mechanical)
VALUES ('shinobi', 'Shinobi', 'sega/system16a.cpp', 0, 0, 0);
`;

let db: DatabaseSync;

beforeEach(() => {
  db = createSchemaDatabase();
  db.exec(SEED);
});

afterEach(() => {
  db.close();
});

describe('schema.sql applies under node:sqlite', () => {
  it('creates exactly the documented tables', () => {
    expect(listTables(db)).toEqual(TABLES);
  });

  it('creates exactly the documented views', () => {
    expect(listViews(db)).toEqual(VIEWS);
  });

  it('creates exactly the documented indexes and nothing speculative', () => {
    expect(listIndexes(db).map((index) => index.name)).toEqual(INDEXES);
  });

  it('leaves the database structurally sound', () => {
    expect(checkIntegrity(db)).toEqual([]);
  });

  it('stamps its own version in exactly one place', () => {
    expect(db.prepare('PRAGMA user_version').get()?.['user_version']).toBe(SCHEMA_USER_VERSION);
    // MINOR 5: the version used to live in a schema_version table, PRAGMA user_version
    // and dataset_meta all at once, reconciled by a loader assertion that existed only
    // because it was stored more than once. The table is gone.
    expect(listTables(db)).not.toContain('schema_version');
    expect(readSchemaSql()).not.toMatch(/schema_version\s*\(/);
  });

  it('counts its own objects the way sqlite_master does', () => {
    const header = /(\d+) tables · (\d+) views · (\d+) explicit indexes/.exec(readSchemaSql());
    expect(header).not.toBeNull();
    expect([header?.[1], header?.[2], header?.[3]]).toEqual([
      String(listTables(db).length),
      String(listViews(db).length),
      String(listIndexes(db).length),
    ]);
  });

  it('fixes the page size and encoding before the first table, for byte-identical builds', () => {
    expect(db.prepare('PRAGMA page_size').get()?.['page_size']).toBe(4096);
    expect(db.prepare('PRAGMA encoding').get()?.['encoding']).toBe('UTF-8');
  });

  it('is idempotent to read and re-appliable to a fresh database', () => {
    const second = createSchemaDatabase();
    expect(listTables(second)).toEqual(TABLES);
    second.close();
    expect(readSchemaSql()).toContain('PRAGMA foreign_keys = ON;');
  });

  it('declares every table STRICT and WITHOUT ROWID with a primary key', () => {
    const rows = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table'").all();
    for (const row of rows) {
      const sql = String(row['sql']);
      expect(sql, `${String(row['name'])} is not STRICT`).toMatch(/STRICT/);
      expect(sql, `${String(row['name'])} has a rowid`).toMatch(/WITHOUT ROWID/);
    }
    for (const table of describeTables(db)) {
      expect(table.primaryKey.length, `${table.name} has no primary key`).toBeGreaterThan(0);
    }
  });

  it('declares an explicit ON DELETE behaviour on every foreign key', () => {
    for (const table of describeTables(db)) {
      for (const fk of table.foreignKeys) {
        expect(fk.onDelete, `${table.name}.${fk.column}`).not.toBe('NO ACTION');
        expect(['CASCADE', 'RESTRICT', 'SET NULL']).toContain(fk.onDelete);
      }
    }
  });

  it('exposes every view as a runnable query', () => {
    for (const view of VIEWS) {
      expect(() => db.prepare(`SELECT * FROM ${view} LIMIT 1`).all()).not.toThrow();
    }
  });

  it('cannot be applied twice to one database', () => {
    const fresh = createSchemaDatabase();
    expect(() => {
      applySchema(fresh);
    }).toThrow(/already exists/);
    fresh.close();
  });

  it('turns foreign keys on even when the connection opened with them off', () => {
    // MINOR 8. `PRAGMA foreign_keys = ON` is a silent no-op inside a transaction, so the
    // DDL cannot be trusted to have taken effect — applySchema reads it back. This is the
    // hostile case: a connection that starts with enforcement off.
    const fresh = new Database(':memory:', { enableForeignKeyConstraints: false });
    expect(fresh.prepare('PRAGMA foreign_keys').get()?.['foreign_keys']).toBe(0);
    applySchema(fresh);
    expect(fresh.prepare('PRAGMA foreign_keys').get()?.['foreign_keys']).toBe(1);
    expect(() => {
      fresh.exec(`INSERT INTO chip (chip_id, display_name, function_id) VALUES ('x','X','ghost')`);
    }).toThrow(/FOREIGN KEY constraint failed/);
    fresh.close();
  });

  it('refuses to apply inside a transaction, where the pragma is silently ignored', () => {
    const fresh = new Database(':memory:', { enableForeignKeyConstraints: false });
    fresh.exec('BEGIN');
    expect(() => {
      applySchema(fresh);
    }).toThrow(/PRAGMA foreign_keys did not take effect/);
    fresh.close();
  });
});

interface Rejection {
  readonly what: string;
  readonly sql: string;
  readonly message: RegExp;
}

const REJECTIONS: readonly Rejection[] = [
  // --- foreign keys ---
  {
    what: 'a chip pointing at a function that does not exist',
    sql: `INSERT INTO chip (chip_id, display_name, function_id) VALUES ('ym2151', 'YM2151', 'nope')`,
    message: /FOREIGN KEY constraint failed/,
  },
  {
    what: 'a BOM row naming a chip that does not exist',
    sql: `INSERT INTO system_chip (system_id, role_id, chip_id) VALUES ('sega-system16a', 'maincpu', 'nope')`,
    message: /FOREIGN KEY constraint failed/,
  },
  {
    what: 'an implementation of an unknown kind',
    sql: `INSERT INTO implementation (implementation_id, name, kind_id) VALUES ('x', 'X', 'nope')`,
    message: /FOREIGN KEY constraint failed/,
  },
  // --- primary keys and unique indexes ---
  {
    what: 'a duplicate chip id',
    sql: `INSERT INTO chip (chip_id, display_name, function_id) VALUES ('z80', 'Z80 again', 'cpu')`,
    message: /UNIQUE constraint failed: chip\.chip_id/,
  },
  {
    what: 'a duplicate BOM row',
    sql: `INSERT INTO system_chip (system_id, role_id, chip_id) VALUES ('sega-system16a', 'maincpu', 'z80');
          INSERT INTO system_chip (system_id, role_id, chip_id) VALUES ('sega-system16a', 'maincpu', 'z80')`,
    message: /UNIQUE constraint failed: system_chip/,
  },
  {
    what: 'two systems claiming one MAME driver source file as their bulk default',
    sql: `INSERT INTO system (system_id, name, kind_id) VALUES ('sega-system16b', 'Sega System 16B', 'arcade');
          INSERT INTO system_driver VALUES ('sega/system16a.cpp', 'sega-system16a');
          INSERT INTO system_driver VALUES ('sega/system16a.cpp', 'sega-system16b')`,
    message: /UNIQUE constraint failed: system_driver\.mame_sourcefile/,
  },
  {
    what: 'two chips in one MAME socket, which inflates every coverage number downstream',
    sql: `INSERT INTO machine_chip (machine_id, mame_tag, chip_id) VALUES ('shinobi', 'maincpu', 'm68000');
          INSERT INTO machine_chip (machine_id, mame_tag, chip_id) VALUES ('shinobi', 'maincpu', 'z80')`,
    message: /UNIQUE constraint failed: machine_chip\.machine_id, machine_chip\.mame_tag/,
  },
  {
    what: 'a correction that puts a second chip in an already-occupied socket',
    sql: `INSERT INTO machine_chip_correction (machine_id, mame_tag, chip_id, op, reason)
            VALUES ('shinobi', 'maincpu', 'm68000', 'remove', 'not on this board');
          INSERT INTO machine_chip_correction (machine_id, mame_tag, chip_id, op, reason)
            VALUES ('shinobi', 'maincpu', 'z80', 'remove', 'nor is this one')`,
    message:
      /UNIQUE constraint failed: machine_chip_correction\.machine_id, machine_chip_correction\.mame_tag/,
  },
  {
    what: 'original silicon claiming a repository and an HDL language',
    sql: `INSERT INTO implementation_kind VALUES ('original_silicon', 'Original silicon', 'As manufactured.');
          INSERT INTO implementation (implementation_id, name, kind_id, repo_url)
          VALUES ('s16a-pcb', 'System 16A PCB', 'original_silicon', 'https://example.org/pcb')`,
    message: /CHECK constraint failed: kind_id <> 'original_silicon'/,
  },
  {
    what: 'a dotted meta key with an empty segment',
    sql: `INSERT INTO dataset_meta VALUES ('threshold..warn', '0.7')`,
    message: /CHECK constraint failed/,
  },
  {
    what: 'a threshold whose value is not a number, which used to CAST to 0.0 and disable its gate',
    sql: `INSERT INTO threshold VALUES ('stale_review_days', 'a year or so')`,
    message: /cannot store TEXT value in REAL column threshold\.value/,
  },
  {
    what: 'a negative threshold',
    sql: `INSERT INTO threshold VALUES ('stale_review_days', -1)`,
    message: /CHECK constraint failed: value >= 0/,
  },
  {
    what: 'a repository path with an empty segment',
    sql: `INSERT INTO implementation_path VALUES ('jt51', 'hdl//jt51.v', 0)`,
    message: /CHECK constraint failed/,
  },
  {
    what: 'a repository path with a trailing slash',
    sql: `INSERT INTO implementation_path VALUES ('jt51', 'hdl/', 0)`,
    message: /CHECK constraint failed/,
  },
  {
    what: 'a repository path containing a space',
    sql: `INSERT INTO implementation_path VALUES ('jt51', 'hdl/jt 51.v', 0)`,
    message: /CHECK constraint failed/,
  },
  {
    what: 'one alternate name resolving to two chips',
    sql: `INSERT INTO chip_name VALUES ('z80', 'MC68000', 'alias');
          INSERT INTO chip_name VALUES ('m68000', 'MC68000', 'alias')`,
    message: /UNIQUE constraint failed: chip_name\.name/,
  },
  {
    what: 'two top-level modules in one implementation',
    sql: `INSERT INTO implementation_path VALUES ('jt51', 'hdl/jt51.v', 1);
          INSERT INTO implementation_path VALUES ('jt51', 'hdl/jt51_op.v', 1)`,
    message: /UNIQUE constraint failed: implementation_path\.implementation_id/,
  },
  {
    what: 'mutual provides, which is equivalence written twice',
    sql: `INSERT INTO chip_equivalence VALUES ('m68010', 'm68000', 'provides', 'a superset of the 68000 instruction set');
          INSERT INTO chip_equivalence VALUES ('m68000', 'm68010', 'provides', 'and back again, which cannot be true')`,
    message: /UNIQUE constraint failed: index 'ux_chip_equivalence_pair'/,
  },
  {
    what: 'an equivalent pair shadowed by a provides edge',
    sql: `INSERT INTO chip_equivalence VALUES ('m68000', 'm68010', 'equivalent', 'interchangeable in both directions');
          INSERT INTO chip_equivalence VALUES ('m68010', 'm68000', 'provides', 'and also one-way, which contradicts it')`,
    message: /UNIQUE constraint failed: index 'ux_chip_equivalence_pair'/,
  },
  // --- NOT NULL and STRICT typing ---
  {
    what: 'an equivalence edge with no justification',
    sql: `INSERT INTO chip_equivalence VALUES ('m68010', 'm68000', 'provides', NULL)`,
    message: /NOT NULL constraint failed: chip_equivalence\.note/,
  },
  {
    what: 'a machine with no name',
    sql: `INSERT INTO machine (machine_id, name, mame_sourcefile, is_bios, is_device, is_mechanical)
          VALUES ('x', NULL, 'a/b.cpp', 0, 0, 0)`,
    message: /NOT NULL constraint failed: machine\.name/,
  },
  {
    what: 'a MAME year string landing in an integer year column',
    sql: `INSERT INTO chip (chip_id, display_name, function_id, year_introduced)
          VALUES ('ym2151', 'YM2151', 'cpu', '19??')`,
    message: /cannot store TEXT value in INTEGER column chip\.year_introduced/,
  },
  {
    what: 'a fractional clock',
    sql: `INSERT INTO system_chip (system_id, role_id, chip_id, clock_hz)
          VALUES ('sega-system16a', 'maincpu', 'z80', 4000000.5)`,
    message: /cannot store REAL value in INTEGER column system_chip\.clock_hz/,
  },
  // --- slug and identifier grammar ---
  {
    what: 'an uppercase chip id',
    sql: `INSERT INTO chip (chip_id, display_name, function_id) VALUES ('YM2151', 'YM2151', 'cpu')`,
    message: /CHECK constraint failed/,
  },
  {
    what: 'a chip id with an underscore',
    sql: `INSERT INTO chip (chip_id, display_name, function_id) VALUES ('ym_2151', 'YM2151', 'cpu')`,
    message: /CHECK constraint failed/,
  },
  {
    what: 'a chip id with a leading separator',
    sql: `INSERT INTO chip (chip_id, display_name, function_id) VALUES ('-ym2151', 'YM2151', 'cpu')`,
    message: /CHECK constraint failed/,
  },
  {
    what: 'a chip id with a trailing separator',
    sql: `INSERT INTO chip (chip_id, display_name, function_id) VALUES ('ym2151-', 'YM2151', 'cpu')`,
    message: /CHECK constraint failed/,
  },
  {
    what: 'a chip id with an empty segment',
    sql: `INSERT INTO chip (chip_id, display_name, function_id) VALUES ('ym--2151', 'YM2151', 'cpu')`,
    message: /CHECK constraint failed/,
  },
  {
    what: 'a dotted function id, which taxonomy.md replaced with hyphens',
    sql: `INSERT INTO chip_function VALUES ('sound.fm', 'FM', 'x', 'medium')`,
    message: /CHECK constraint failed/,
  },
  {
    what: 'a machine id outside MAME shortname grammar',
    sql: `INSERT INTO machine (machine_id, name, mame_sourcefile, is_bios, is_device, is_mechanical)
          VALUES ('Shinobi', 'Shinobi', 'a/b.cpp', 0, 0, 0)`,
    message: /CHECK constraint failed/,
  },
  {
    what: 'a Windows-style driver source path',
    sql: `INSERT INTO machine (machine_id, name, mame_sourcefile, is_bios, is_device, is_mechanical)
          VALUES ('x', 'X', 'sega\\system16a.cpp', 0, 0, 0)`,
    message: /CHECK constraint failed/,
  },
  {
    what: 'a driver source path that is not a .cpp file',
    sql: `INSERT INTO system_driver VALUES ('sega/system16a.h', 'sega-system16a')`,
    message: /CHECK constraint failed/,
  },
  {
    what: 'a MAME tag with a leading colon that extraction should have stripped',
    sql: `INSERT INTO machine_chip (machine_id, mame_tag, chip_id) VALUES ('shinobi', ':maincpu', 'z80')`,
    message: /CHECK constraint failed/,
  },
  {
    what: 'a country code that is not ISO 3166-1 alpha-2',
    sql: `INSERT INTO manufacturer (manufacturer_id, name, country) VALUES ('sega', 'Sega', 'Japan')`,
    message: /CHECK constraint failed/,
  },
  {
    what: 'a datasheet link that is not an absolute http(s) URI',
    sql: `INSERT INTO chip_datasheet VALUES ('z80', 'z80.pdf', 'Z80 datasheet')`,
    message: /CHECK constraint failed/,
  },
  {
    what: 'a URL containing a space',
    sql: `INSERT INTO chip_datasheet VALUES ('z80', 'https://example.org/z 80.pdf', NULL)`,
    message: /CHECK constraint failed/,
  },
  // --- domain and range CHECKs ---
  {
    what: 'a blank display name',
    sql: `INSERT INTO chip (chip_id, display_name, function_id) VALUES ('ym2151', '   ', 'cpu')`,
    message: /CHECK constraint failed: trim\(display_name\)/,
  },
  {
    what: 'a blank equivalence note',
    sql: `INSERT INTO chip_equivalence VALUES ('m68010', 'm68000', 'provides', '  ')`,
    message: /CHECK constraint failed: trim\(note\)/,
  },
  {
    what: 'a prospector band outside the taxonomy',
    sql: `INSERT INTO chip_function VALUES ('dsp', 'DSP', 'x', 'impossible')`,
    message: /CHECK constraint failed: prospector_band IN/,
  },
  {
    what: 'a driver status MAME does not report',
    sql: `INSERT INTO machine (machine_id, name, mame_sourcefile, driver_status, is_bios, is_device, is_mechanical)
          VALUES ('x', 'X', 'a/b.cpp', 'excellent', 0, 0, 0)`,
    message: /CHECK constraint failed/,
  },
  {
    what: 'a boolean column holding something other than 0 or 1',
    sql: `INSERT INTO machine (machine_id, name, mame_sourcefile, is_bios, is_device, is_mechanical)
          VALUES ('x', 'X', 'a/b.cpp', 2, 0, 0)`,
    message: /CHECK constraint failed: is_bios IN \(0,1\)/,
  },
  {
    what: 'a quantity of zero',
    sql: `INSERT INTO system_chip (system_id, role_id, chip_id, quantity)
          VALUES ('sega-system16a', 'maincpu', 'z80', 0)`,
    message: /CHECK constraint failed: quantity >= 1/,
  },
  {
    what: 'a clock of zero',
    sql: `INSERT INTO system_chip (system_id, role_id, chip_id, clock_hz)
          VALUES ('sega-system16a', 'maincpu', 'z80', 0)`,
    message: /CHECK constraint failed/,
  },
  {
    what: 'a year outside the plausible range',
    sql: `INSERT INTO chip (chip_id, display_name, function_id, year_introduced)
          VALUES ('ym2151', 'YM2151', 'cpu', 1849)`,
    message: /CHECK constraint failed/,
  },
  {
    what: 'a review date that is not YYYY-MM-DD',
    sql: `INSERT INTO implementation (implementation_id, name, kind_id, last_reviewed)
          VALUES ('x', 'X', 'fpga_hdl', '2026/01/01')`,
    message: /CHECK constraint failed/,
  },
  // --- structural invariants ---
  {
    what: 'a MAME device that is both mapped and ignored',
    sql: `INSERT INTO mame_device VALUES ('z80', 'z80', 'screen', NULL)`,
    message: /CHECK constraint failed: \(chip_id IS NULL\) <> \(ignore_reason IS NULL\)/,
  },
  {
    what: 'a MAME device that is neither mapped nor ignored',
    sql: `INSERT INTO mame_device VALUES ('z80', NULL, NULL, NULL)`,
    message: /CHECK constraint failed: \(chip_id IS NULL\) <> \(ignore_reason IS NULL\)/,
  },
  {
    what: 'a chip equivalent to itself',
    sql: `INSERT INTO chip_equivalence VALUES ('z80', 'z80', 'provides', 'a chip is not a substitute for itself')`,
    message: /CHECK constraint failed: from_chip_id <> to_chip_id/,
  },
  {
    what: 'a symmetric edge stored in the non-canonical direction',
    sql: `INSERT INTO chip_equivalence VALUES ('m68010', 'm68000', 'equivalent', 'stored backwards, so the mirror row could appear too')`,
    message: /CHECK constraint failed: kind <> 'equivalent' OR from_chip_id < to_chip_id/,
  },
  {
    what: 'an equivalence kind outside the two relations',
    sql: `INSERT INTO chip_equivalence VALUES ('m68010', 'm68000', 'similar', 'a third relation nothing implements')`,
    message: /CHECK constraint failed: kind IN \('equivalent','provides'\)/,
  },
  {
    what: 'an implementation depending on itself',
    sql: `INSERT INTO implementation_dependency VALUES ('jt51', 'jt51', NULL)`,
    message: /CHECK constraint failed: consumer_id <> provider_id/,
  },
  {
    what: 'a hardware-verified claim with no citation',
    sql: `INSERT INTO implementation (implementation_id, name, kind_id, verified_against_hardware)
          VALUES ('x', 'X', 'fpga_hdl', 1)`,
    message: /CHECK constraint failed/,
  },
  {
    what: 'a retired id that is not shaped like an id',
    sql: `INSERT INTO chip_name VALUES ('z80', 'Zilog Z80 CPU', 'retired_id')`,
    message: /CHECK constraint failed: kind <> 'retired_id'/,
  },
  {
    what: 'an alias row that shadows its own chip id',
    sql: `INSERT INTO chip_name VALUES ('z80', 'z80', 'alias')`,
    message: /CHECK constraint failed: name <> chip_id/,
  },
  {
    what: "a 'remove' correction carrying values it cannot apply",
    sql: `INSERT INTO machine_chip_correction (machine_id, mame_tag, chip_id, op, clock_hz, reason)
          VALUES ('shinobi', 'maincpu', 'z80', 'remove', 4000000, 'not on this board')`,
    message: /CHECK constraint failed: op <> 'remove'/,
  },
  {
    what: "a 'set' correction that sets nothing",
    sql: `INSERT INTO machine_chip_correction (machine_id, mame_tag, chip_id, op, reason)
          VALUES ('shinobi', 'maincpu', 'z80', 'set', 'no values, so nothing happens')`,
    message: /CHECK constraint failed: op <> 'set'/,
  },
  {
    what: 'a correction operation the loader does not implement',
    sql: `INSERT INTO machine_chip_correction (machine_id, mame_tag, chip_id, op, reason)
          VALUES ('shinobi', 'maincpu', 'z80', 'upsert', 'no code implements this')`,
    message: /CHECK constraint failed: op IN \('add','remove','set'\)/,
  },
];

describe('the schema rejects', () => {
  for (const rejection of REJECTIONS) {
    it(rejection.what, () => {
      expect(() => {
        db.exec(rejection.sql);
      }).toThrow(rejection.message);
    });
  }
});

describe('the schema accepts what it should', () => {
  it('one chip in two roles, and two chips in one role', () => {
    expect(() => {
      db.exec(`
        INSERT INTO chip_role (role_id, label) VALUES ('audiocpu', 'Audio CPU'), ('sound', 'Sound');
        INSERT INTO system_chip (system_id, role_id, chip_id) VALUES
          ('sega-system16a', 'maincpu',  'z80'),
          ('sega-system16a', 'audiocpu', 'z80'),
          ('sega-system16a', 'sound',    'm68000');
      `);
    }).not.toThrow();
  });

  it('an implementation claiming several chips', () => {
    expect(() => {
      db.exec(`INSERT INTO implementation_chip VALUES ('jt51', 'm68000'), ('jt51', 'm68010')`);
    }).not.toThrow();
  });

  it('several machine_chip rows for tagless device_refs, which carry no socket', () => {
    // ux_machine_chip_tag keys tagged rows only: ':device' is the sentinel for MAME's
    // <device_ref>, which has no tag at all, so several are ordinary and expected.
    expect(() => {
      db.exec(
        `INSERT INTO machine_chip (machine_id, mame_tag, chip_id) VALUES
           ('shinobi', ':device', 'z80'), ('shinobi', ':device', 'm68000')`,
      );
    }).not.toThrow();
  });

  it('one chip under two different MAME tags in one machine', () => {
    expect(() => {
      db.exec(
        `INSERT INTO machine_chip (machine_id, mame_tag, chip_id) VALUES
           ('shinobi', 'maincpu', 'z80'), ('shinobi', 'audiocpu', 'z80')`,
      );
    }).not.toThrow();
  });

  it('a per-machine system assignment with no reason, because it is not a correction', () => {
    expect(() => {
      db.exec(
        `INSERT INTO machine_system (machine_id, system_id) VALUES ('shinobi', 'sega-system16a')`,
      );
    }).not.toThrow();
  });

  it('a deliberately system-less machine, which a NULL expresses', () => {
    expect(() => {
      db.exec(
        `INSERT INTO machine_system VALUES ('shinobi', NULL, 'a prototype with no board family')`,
      );
    }).not.toThrow();
    expect(
      db.prepare("SELECT system_id FROM v_machine_system WHERE machine_id = 'shinobi'").get()?.[
        'system_id'
      ],
    ).toBeNull();
  });

  it('one driver source file hosting two systems, one machine at a time', () => {
    // MAJOR 4: nintendo/vsnes.cpp is VS. UniSystem *and* VS. DualSystem. system_driver is
    // the bulk default; machine_system is the per-machine truth and takes precedence.
    db.exec(`
      INSERT INTO system (system_id, name, kind_id) VALUES ('sega-system16c', 'Sega System 16C', 'arcade');
      INSERT INTO system_driver VALUES ('sega/system16a.cpp', 'sega-system16a');
      INSERT INTO machine (machine_id, name, mame_sourcefile, is_bios, is_device, is_mechanical)
      VALUES ('aceattac', 'Ace Attacker', 'sega/system16a.cpp', 0, 0, 0);
      INSERT INTO machine_system (machine_id, system_id) VALUES ('aceattac', 'sega-system16c');
    `);
    expect(
      db.prepare('SELECT machine_id, system_id FROM v_machine_system ORDER BY 1').all(),
    ).toEqual([
      { machine_id: 'aceattac', system_id: 'sega-system16c' },
      { machine_id: 'shinobi', system_id: 'sega-system16a' },
    ]);
    // …and removing the system must not silently resurrect the default it overrode.
    expect(() => {
      db.exec(`DELETE FROM system WHERE system_id = 'sega-system16c'`);
    }).toThrow(/FOREIGN KEY constraint failed/);
  });
});

describe('foreign keys are enforced, and the check is free', () => {
  it('reports a dangling reference inserted while enforcement was off', () => {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(
      `INSERT INTO system_chip (system_id, role_id, chip_id) VALUES ('sega-system16a', 'maincpu', 'ghost')`,
    );
    db.exec('PRAGMA foreign_keys = ON');
    const problems = checkIntegrity(db);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/system_chip/);
  });

  it('restricts deleting a chip a BOM depends on, and cascades a system delete', () => {
    db.exec(
      `INSERT INTO system_chip (system_id, role_id, chip_id) VALUES ('sega-system16a', 'maincpu', 'z80')`,
    );
    expect(() => {
      db.exec(`DELETE FROM chip WHERE chip_id = 'z80'`);
    }).toThrow(/FOREIGN KEY constraint failed/);
    db.exec(`DELETE FROM system WHERE system_id = 'sega-system16a'`);
    expect(db.prepare('SELECT COUNT(*) AS n FROM system_chip').get()?.['n']).toBe(0);
  });

  it('has no self-referencing foreign key left to make a query conditional', () => {
    // MAJOR 1: extraction is parents-only, so machine held no clone rows and
    // machine.parent_machine_id was a nullable self-FK pointing at nothing.
    for (const table of describeTables(db)) {
      for (const fk of table.foreignKeys) {
        expect(fk.parentTable, `${table.name}.${fk.column}`).not.toBe(table.name);
      }
    }
    expect(describeTable(db, 'machine').columns.map((c) => c.name)).not.toContain(
      'parent_machine_id',
    );
  });

  it('keeps clone_count as a base MAME fact that no row in this database contradicts', () => {
    db.exec(`
      UPDATE machine SET clone_count = 99 WHERE machine_id = 'shinobi';
      INSERT INTO machine (machine_id, name, mame_sourcefile, is_bios, is_device, is_mechanical)
      VALUES ('shinobi1', 'Shinobi (set 1)', 'sega/system16a.cpp', 0, 0, 0);
    `);
    // The reproduced defect was a parent claiming 99 clones beside exactly one child row.
    // With no parent pointer there is no child row to disagree with, and v_machine
    // republishes MAME's own number rather than an aggregate over rows it can see.
    expect(
      db.prepare("SELECT clone_count FROM v_machine WHERE machine_id = 'shinobi'").get(),
    ).toEqual({ clone_count: 99 });
  });
});

// ---------------------------------------------------------------------------
// Grammar equality: every CHECK, proved equal to the JSON Schema pattern it mirrors
// ---------------------------------------------------------------------------

interface Grammar {
  /** The `$defs` key in schemas/common.schema.json. */
  readonly def: string;
  /** Alphabet the corpus is enumerated over. */
  readonly alphabet: readonly string[];
  /** Longest enumerated word. */
  readonly maxLength: number;
  /** Strings worth trying that a short enumeration would never reach. */
  readonly extras: readonly string[];
  /** Insert offering the candidate as the only unknown, and its undo. */
  readonly insert: string;
  readonly cleanup: string;
}

const repeat = (character: string, count: number): string => character.repeat(count);

/**
 * One row per grammar of schemas/schema.sql's header. Each is offered the same corpus
 * twice — once to the live DDL and once to the regex `common.schema.json` publishes —
 * and any string the two disagree about fails the test. That is what "the CHECK and the
 * JSON pattern are equal" means; nothing weaker is checkable, because neither artifact
 * can be derived from the other.
 */
const GRAMMARS: readonly Grammar[] = [
  {
    def: 'slug',
    alphabet: ['a', 'z', '0', '-', '_', 'A'],
    maxLength: 3,
    extras: [repeat('a', 64), repeat('a', 65)],
    insert: `INSERT INTO chip_role (role_id, label) VALUES (?, 'L')`,
    cleanup: `DELETE FROM chip_role WHERE role_id <> 'maincpu'`,
  },
  {
    def: 'identifier',
    alphabet: ['a', '0', '-', '_', 'A'],
    maxLength: 3,
    extras: [repeat('a', 64), repeat('a', 65)],
    insert: `INSERT INTO implementation_kind VALUES (?, 'L', 'D')`,
    cleanup: `DELETE FROM implementation_kind WHERE kind_id <> 'fpga_hdl'`,
  },
  {
    def: 'spdxId',
    alphabet: ['A', 'a', '0', '.', '+', '-', '_', ' '],
    maxLength: 3,
    extras: [repeat('a', 64), repeat('a', 65)],
    insert: `INSERT INTO license VALUES (?, 'n', NULL, 1)`,
    cleanup: 'DELETE FROM license',
  },
  {
    def: 'mameShortname',
    alphabet: ['a', '0', '_', '-', 'A'],
    maxLength: 3,
    extras: [repeat('a', 32), repeat('a', 33)],
    insert: `INSERT INTO machine (machine_id, name, mame_sourcefile, is_bios, is_device, is_mechanical)
             VALUES (?, 'N', 'a/b.cpp', 0, 0, 0)`,
    cleanup: `DELETE FROM machine WHERE machine_id <> 'shinobi'`,
  },
  {
    def: 'mameDeviceKey',
    alphabet: ['a', '0', '_', '-', 'A'],
    maxLength: 3,
    extras: [repeat('a', 64), repeat('a', 65)],
    insert: `INSERT INTO mame_device (mame_device, chip_id) VALUES (?, 'z80')`,
    cleanup: 'DELETE FROM mame_device',
  },
  {
    def: 'mameTag',
    alphabet: ['a', '0', '_', '.', ':'],
    maxLength: 3,
    extras: [':device', repeat('a', 64)],
    insert: `INSERT INTO machine_chip (machine_id, mame_tag, chip_id) VALUES ('shinobi', ?, 'z80')`,
    cleanup: 'DELETE FROM machine_chip',
  },
  {
    def: 'sourcefile',
    alphabet: ['a', '0', '_', '/', '.', 'c', 'p'],
    maxLength: 4,
    extras: [
      'a/b.cpp',
      'a.cpp',
      '/a.cpp',
      'a//b.cpp',
      'a/.cpp',
      `${repeat('a', 124)}.cpp`,
      `${repeat('a', 125)}.cpp`,
    ],
    insert: `INSERT INTO system_driver VALUES (?, 'sega-system16a')`,
    cleanup: 'DELETE FROM system_driver',
  },
  {
    def: 'repoPath',
    alphabet: ['a', 'A', '0', '.', '_', '+', '-', '/', ' '],
    maxLength: 3,
    extras: ['a//b', 'a/', '/a', 'a b', repeat('x', 256), repeat('x', 257)],
    insert: `INSERT INTO implementation_path (implementation_id, path) VALUES ('jt51', ?)`,
    cleanup: 'DELETE FROM implementation_path',
  },
  {
    def: 'metaKey',
    alphabet: ['a', 'z', '0', '_', '.', 'A', ' '],
    maxLength: 3,
    extras: ['a..b', 'a.', '.a', repeat('a', 64), repeat('a', 65)],
    insert: `INSERT INTO dataset_meta (key, value) VALUES (?, 'v')`,
    cleanup: 'DELETE FROM dataset_meta',
  },
  {
    def: 'isoDate',
    alphabet: ['0', '9', '-'],
    maxLength: 4,
    extras: ['2026-01-15', '2026/01/15', '20260115'],
    insert: `UPDATE implementation SET last_reviewed = ? WHERE implementation_id = 'jt51'`,
    cleanup: `UPDATE implementation SET last_reviewed = NULL WHERE implementation_id = 'jt51'`,
  },
  {
    def: 'countryCode',
    alphabet: ['A', 'Z', 'a', '0'],
    maxLength: 2,
    extras: ['JP', 'jp', 'J', 'JPN'],
    insert: `INSERT INTO manufacturer (manufacturer_id, name, country) VALUES ('x', 'X', ?)`,
    cleanup: `DELETE FROM manufacturer WHERE manufacturer_id <> 'zilog'`,
  },
];

interface CommonDef {
  readonly pattern?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
}

function commonDefs(): Record<string, CommonDef> {
  const raw = JSON.parse(readFileSync(join(SCHEMAS_DIR, 'common.schema.json'), 'utf8')) as {
    $defs: Record<string, CommonDef>;
  };
  return raw.$defs;
}

/** Every word of length 0..maxLength over `alphabet`. */
function corpus(alphabet: readonly string[], maxLength: number): string[] {
  const out = [''];
  let level = [''];
  for (let n = 0; n < maxLength; n += 1) {
    const next: string[] = [];
    for (const word of level) for (const character of alphabet) next.push(word + character);
    out.push(...next);
    level = next;
  }
  return out;
}

describe('every DDL grammar equals the JSON Schema pattern that mirrors it', () => {
  const defs = commonDefs();

  for (const grammar of GRAMMARS) {
    it(`${grammar.def} accepts and rejects exactly the same strings`, () => {
      const def = defs[grammar.def];
      expect(def, `no $defs/${grammar.def} in common.schema.json`).toBeDefined();
      const pattern = def?.pattern;
      expect(pattern, `$defs/${grammar.def} declares no pattern`).toBeDefined();
      const regex = new RegExp(pattern ?? '');
      const minLength = def?.minLength ?? 0;
      const maxLength = def?.maxLength ?? Number.POSITIVE_INFINITY;

      const candidates = [
        ...new Set([...corpus(grammar.alphabet, grammar.maxLength), ...grammar.extras]),
      ];
      const statement = db.prepare(grammar.insert);
      const disagreements: { value: string; ddl: boolean; json: boolean }[] = [];
      for (const value of candidates) {
        let ddl = true;
        try {
          statement.run(value);
          db.exec(grammar.cleanup);
        } catch {
          ddl = false;
        }
        const json = regex.test(value) && value.length >= minLength && value.length <= maxLength;
        if (ddl !== json) disagreements.push({ value, ddl, json });
      }
      expect(candidates.length).toBeGreaterThan(20);
      expect(disagreements).toEqual([]);
    });
  }
});
