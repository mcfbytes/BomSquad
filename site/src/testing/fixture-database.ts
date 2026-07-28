import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * The fixture **database** the unit tests run against.
 *
 * A real SQLite file, built by applying the shipped `schemas/schema.sql` whole —
 * all 36 tables, all 21 views, all 34 indexes, every CHECK — to an empty database
 * and inserting a small hand-written dataset. Not fixture chunks, not stubbed rows,
 * not a mock engine: T7.2's acceptance criterion is specifically "unit tests run
 * against a fixture database", because the thing worth testing is whether the
 * queries are right against the schema that ships.
 *
 * It is deliberately tiny (5 chips, 2 systems, 3 machines, 4 implementations) and
 * deliberately awkward in the ways the real data is awkward:
 *
 * - `z80` carries both an `alias` and a `retired_id` in `chip_name`, so search has
 *   to find a chip by a name that is not its primary one;
 * - `capcom-cps1` carries the alias `CPS-1`, likewise in `system_name`;
 * - `z80a` is `equivalent` to `z80`, so `v_chip_evidence` has a rank-2 row;
 * - `mc6809` has no implementation at all, so `v_chip_gap` is not empty;
 * - `zaxxon` belongs to no system, so `v_machine.system_id` is NULL somewhere;
 * - one implementation has no licence, so `v_quality_warning` fires.
 *
 * Every insert below has to satisfy the real CHECK constraints and foreign keys —
 * that is a large part of its value as a fixture.
 */

const SEED_SQL = `
PRAGMA foreign_keys = ON;

INSERT INTO chip_function (function_id, label, description, prospector_band) VALUES
  ('cpu',    'CPU',          'General-purpose processor.',      'medium'),
  ('sound',  'Sound',        'Audio generation.',               'hard'),
  ('custom', 'Custom ASIC',  'Board-specific ASIC.',            'hard');

INSERT INTO manufacturer (manufacturer_id, name, country) VALUES
  ('zilog',    'Zilog',            'US'),
  ('yamaha',   'Yamaha',           'JP'),
  ('motorola', 'Motorola',         'US'),
  ('sega',     'Sega',             'JP'),
  ('capcom',   'Capcom',           'JP');

INSERT INTO chip (chip_id, display_name, function_id, manufacturer_id, year_introduced) VALUES
  ('z80',           'Z80',           'cpu',    'zilog',    1976),
  ('z80a',          'Z80A',          'cpu',    'zilog',    1977),
  ('ym2151',        'YM2151',        'sound',  'yamaha',   1983),
  ('m68000',        'M68000',        'cpu',    'motorola', 1979),
  ('sega-315-5011', 'Sega 315-5011', 'custom', 'sega',     1985);

INSERT INTO chip_name (chip_id, name, kind) VALUES
  ('z80',    'Z-80',      'alias'),
  ('z80',    'zilog-z80', 'retired_id'),
  ('ym2151', 'OPM',       'alias');

-- The DDL requires from_chip_id < to_chip_id on an 'equivalent' edge, so the pair
-- is stored once rather than twice; v_chip_satisfies expands it both ways.
INSERT INTO chip_equivalence (from_chip_id, to_chip_id, kind, note) VALUES
  ('z80', 'z80a', 'equivalent', 'Same core, higher clock rating.');

INSERT INTO system_kind (kind_id, label) VALUES ('arcade', 'Arcade');

INSERT INTO system (system_id, name, kind_id, manufacturer_id, year_introduced) VALUES
  ('sega-system1', 'Sega System 1', 'arcade', 'sega',   1983),
  ('capcom-cps1',  'Capcom CPS-1',  'arcade', 'capcom', 1988);

INSERT INTO system_name (system_id, name, kind) VALUES
  ('capcom-cps1',  'CPS-1',    'alias'),
  ('sega-system1', 'System 1', 'alias');

INSERT INTO system_driver (mame_sourcefile, system_id) VALUES
  ('sega/system1.cpp', 'sega-system1'),
  ('capcom/cps1.cpp',  'capcom-cps1');

INSERT INTO chip_role (role_id, label) VALUES
  ('maincpu',  'Main CPU'),
  ('audiocpu', 'Audio CPU'),
  ('fm',       'FM synthesis');

INSERT INTO system_chip (system_id, role_id, chip_id, quantity) VALUES
  ('capcom-cps1', 'maincpu', 'm68000', 1),
  ('capcom-cps1', 'fm',      'ym2151', 1);

INSERT INTO machine
  (machine_id, name, mame_sourcefile, mame_year, mame_manufacturer, clone_count,
   driver_status, is_bios, is_device, is_mechanical)
VALUES
  ('wboy',   'Wonder Boy',                          'sega/system1.cpp', '1986', 'Sega',   3, 'good',      0, 0, 0),
  ('sf2',    'Street Fighter II: The World Warrior', 'capcom/cps1.cpp',  '1991', 'Capcom', 9, 'good',      0, 0, 0),
  ('zaxxon', 'Zaxxon',                              'sega/zaxxon.cpp',  '19??', 'Sega',   NULL, 'imperfect', 0, 0, 0);

INSERT INTO machine_chip (machine_id, mame_tag, chip_id, clock_hz, quantity) VALUES
  ('wboy',   'maincpu',  'z80',           4000000, 1),
  ('wboy',   'audiocpu', 'z80a',          3000000, 1),
  ('wboy',   'fm',       'ym2151',        3579545, 1),
  ('sf2',    'maincpu',  'm68000',       10000000, 1),
  ('sf2',    'audiocpu', 'z80',           3579545, 1),
  ('sf2',    'custom',   'sega-315-5011',    NULL, 2),
  ('zaxxon', 'maincpu',  'z80',           3072000, 1);

INSERT INTO machine_unmapped_device (machine_id, mame_device, quantity) VALUES
  ('zaxxon', 'sn76496', 3),
  ('wboy',   'i8255',   1);

-- The DDL insists a device row is either mapped to a chip or explicitly ignored,
-- never both and never neither.
INSERT INTO mame_device (mame_device, chip_id, ignore_reason, note) VALUES
  ('z80',      'z80',    NULL,          'Mapped.'),
  ('ym2151',   'ym2151', NULL,          'Mapped.'),
  ('watchdog', NULL,     'not_a_chip',  NULL);

INSERT INTO implementation_kind (kind_id, label, description) VALUES
  ('fpga_hdl',        'FPGA (HDL)',        'Synthesizable hardware description.'),
  ('software_emulation', 'Software emulation', 'Reproduction in software.');

INSERT INTO license (license_id, name, url, is_osi_approved) VALUES
  ('BSD-2-Clause', 'BSD 2-Clause License', 'https://spdx.org/licenses/BSD-2-Clause.html', 1),
  ('MIT',          'MIT License',          'https://spdx.org/licenses/MIT.html',          1);

INSERT INTO accuracy_level (accuracy_id, label, description) VALUES
  ('cycle-approximate', 'Cycle-approximate', 'Close enough in practice.'),
  ('behavioral',        'Behavioral',        'Documented behaviour only.');

INSERT INTO hdl_language (language_id, label) VALUES
  ('vhdl',    'VHDL'),
  ('verilog', 'Verilog');

INSERT INTO fpga_platform (platform_id, label, notes) VALUES
  ('mister',  'MiSTer FPGA',           'DE10-Nano.'),
  ('generic', 'Generic / unspecified', 'No specific board.');

INSERT INTO project (project_id, name, url, author) VALUES
  ('opencores', 'OpenCores', 'https://opencores.org/', 'various'),
  ('jotego',    'JOTEGO',    'https://github.com/jotego', 'Jose Tejada');

INSERT INTO implementation
  (implementation_id, name, kind_id, project_id, repo_url, hdl_language_id,
   license_id, accuracy_id, last_reviewed)
VALUES
  ('t80',   'T80',   'fpga_hdl', 'opencores', 'https://github.com/opencores/t80',  'vhdl',    'BSD-2-Clause', 'cycle-approximate', '2026-01-05'),
  ('jt51',  'JT51',  'fpga_hdl', 'jotego',    'https://github.com/jotego/jt51',    'verilog', 'MIT',          'cycle-approximate', '2026-02-11'),
  ('fx68k', 'FX68K', 'fpga_hdl', NULL,        'https://github.com/ijor/fx68k',     'verilog', NULL,           'cycle-approximate', '2026-03-02'),
  ('jt51-soft', 'JT51 reference model', 'software_emulation', 'jotego', 'https://github.com/jotego/jt51', 'verilog', 'MIT', 'behavioral', '2026-02-11');

INSERT INTO implementation_chip (implementation_id, chip_id) VALUES
  ('t80',       'z80'),
  ('jt51',      'ym2151'),
  ('fx68k',     'm68000'),
  ('jt51-soft', 'ym2151');

INSERT INTO implementation_platform (implementation_id, platform_id) VALUES
  ('t80',   'mister'),
  ('t80',   'generic'),
  ('jt51',  'mister'),
  ('fx68k', 'generic');

INSERT INTO dataset_meta (key, value) VALUES
  ('build_date',     '2026-07-28'),
  ('dataset_version','0.1.0'),
  ('schema_version', '2.0.0'),
  ('mame_version',   '0.999');

INSERT INTO threshold (name, value) VALUES
  ('mapped_instance_share.warn_below',      0.80),
  ('issue_generator.min_instance_count',    2),
  ('issue_generator.min_machine_count',     1),
  ('issue_generator.top_n',                 25),
  ('stale_review_days',                     365),
  ('system_unmapped_share.warn_above',      0.25),
  ('db_max_bytes',                          50331648),
  ('completeness.warn_below',               0.50);
`;

/**
 * `import.meta.url` is the *bundle's* URL once the unit-test builder has run, so
 * paths are resolved from the working directory instead — which the Angular test
 * runner sets to `site/`, and which `theme-assets.spec.ts` already relies on.
 */
const SITE_ROOT = process.cwd();
const REPO_ROOT = resolve(SITE_ROOT, '..');

/**
 * Where the browser engine's wasm binary actually is on this machine.
 *
 * The tests drive the *real* `@sqlite.org/sqlite-wasm` — the engine that ships —
 * rather than a Node stand-in, so `locateFile` has to point at a filesystem path
 * instead of the `/site-data/sqlite3.wasm` URL the deployed app uses.
 */
export const FIXTURE_SQLITE_WASM_PATH = createRequire(join(SITE_ROOT, 'package.json')).resolve(
  '@sqlite.org/sqlite-wasm/sqlite3.wasm',
);

let cachedPath: string | null = null;
let cachedBytes: Uint8Array | null = null;

/**
 * The fixture database on disk. Built once per test process and left in a temp
 * directory the OS will clean up; useful for the specs that want to inspect it with
 * `node:sqlite` rather than through the browser engine.
 */
export function fixtureDatabasePath(): string {
  if (cachedPath !== null) {
    return cachedPath;
  }
  const directory = mkdtempSync(join(tmpdir(), 'bomsquad-fixture-'));
  const path = join(directory, 'fixture.sqlite');
  // node:sqlite will not create a file that is not already there.
  closeSync(openSync(path, 'w'));

  const db = new DatabaseSync(path);
  try {
    db.exec(readFileSync(join(REPO_ROOT, 'schemas/schema.sql'), 'utf8'));
    db.exec(SEED_SQL);
    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length > 0) {
      rmSync(directory, { recursive: true, force: true });
      throw new Error(`fixture database has foreign key violations: ${JSON.stringify(violations)}`);
    }
  } finally {
    db.close();
  }

  cachedPath = path;
  return path;
}

/**
 * The fixture database as bytes, exactly as a `fetch` of `bomsquad.sqlite` would
 * deliver them.
 */
export function fixtureDatabaseBytes(): Uint8Array {
  cachedBytes ??= new Uint8Array(readFileSync(fixtureDatabasePath()));
  return cachedBytes;
}

/** A read-only `node:sqlite` handle on the fixture, for schema-level assertions. */
export function openFixtureDatabase(): DatabaseSync {
  return new DatabaseSync(fixtureDatabasePath(), { readOnly: true });
}
