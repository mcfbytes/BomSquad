/**
 * The row-file JSON Schemas, and the mechanical proof that they still describe the DDL.
 *
 * Three layers, in order of how much they can prove:
 *   1. `diffRowSchemas` — schema and DDL agree column-for-column. Drift is a test failure.
 *   2. ajv (strict, allErrors, ajv-formats) — every table has a valid fixture, and every
 *      invalid fixture isolates one violation and is rejected by the keyword it targets.
 *   3. the loader — discovery, parsing and a byte-identical build from shuffled input.
 */
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import ajvFormatsPlugin from 'ajv-formats';
import type { ErrorObject, ValidateFunction } from 'ajv';

import { applySchema, createSchemaDatabase, SCHEMAS_DIR } from '../src/db/schema.js';
import { listTables } from '../src/db/introspect.js';
import { loadDataset, loadRowFiles } from '../src/db/load.js';
import {
  compareBytes,
  diffRowSchemas,
  discoverRowFiles,
  readRowFile,
  TABLES_WITHOUT_ROW_FILES,
  type Row,
} from '../src/db/rowfiles.js';
import { canonicalQueryFixture } from './fixtures.js';

/**
 * `ajv-formats` assigns `module.exports = formatsPlugin`, but its type declarations
 * describe the plugin as an ES default export. Under NodeNext the declared type of the
 * module is therefore its namespace while the runtime value is the function. One cast,
 * named here rather than scattered.
 */
const addFormats = ajvFormatsPlugin as unknown as (ajv: Ajv2020) => void;

const SCHEMA_ID = 'https://bomsquad.dev/schemas/';
const REPO_ROOT = join(import.meta.dirname, '..', '..');

/** One valid row per table. Every one of these is shaped like real curated data. */
const VALID: Readonly<Record<string, Row>> = {
  accuracy_level: {
    accuracy_id: 'cycle-accurate',
    label: 'Cycle accurate',
    description: 'Matches the part cycle for cycle.',
  },
  chip: {
    chip_id: 'ym2151',
    display_name: 'YM2151',
    function_id: 'sound-fm',
    manufacturer_id: 'yamaha',
    family_id: 'opm',
    model: 'YM2151',
    typical_clock_hz: 3579545,
    package: 'DIP-24',
    year_introduced: 1983,
  },
  chip_datasheet: {
    chip_id: 'ym2151',
    url: 'https://example.org/ym2151.pdf',
    title: 'YM2151 application manual',
  },
  chip_equivalence: {
    from_chip_id: 'ym2612',
    to_chip_id: 'ym3438',
    kind: 'equivalent',
    note: 'The YM3438 is the CMOS die shrink of the YM2612 and is register-compatible in both directions.',
  },
  chip_family: { family_id: 'opm', name: 'OPM', manufacturer_id: 'yamaha' },
  chip_function: {
    function_id: 'sound-fm',
    label: 'FM synthesizer',
    description: 'Sound generator whose defining stage is frequency modulation.',
    prospector_band: 'medium',
  },
  chip_name: { chip_id: 'ym2151', name: 'OPM', kind: 'alias' },
  chip_role: { role_id: 'audiocpu', label: 'Audio CPU' },
  dataset_meta: { key: 'mame_version', value: '0.288' },
  fpga_platform: { platform_id: 'mister', label: 'MiSTer' },
  hdl_language: { language_id: 'verilog', label: 'Verilog' },
  implementation: {
    implementation_id: 'jt51',
    name: 'JT51',
    kind_id: 'fpga_hdl',
    project_id: 'jotego',
    repo_url: 'https://github.com/jotego/jt51',
    hdl_language_id: 'verilog',
    license_id: 'GPL-3.0-only',
    accuracy_id: 'cycle-accurate',
    verified_against_hardware: 1,
    last_reviewed: '2026-01-15',
    notes: 'Compared against a YM2151 on a System 16A board.',
  },
  implementation_chip: { implementation_id: 'jt51', chip_id: 'ym2151' },
  implementation_dependency: {
    consumer_id: 'mister-arcade-cps1',
    provider_id: 'jt51',
    note: 'OPM sound',
  },
  implementation_kind: {
    kind_id: 'fpga_hdl',
    label: 'FPGA HDL',
    description: 'Synthesizable hardware description.',
  },
  implementation_machine: { implementation_id: 'mister-arcade-cps1', machine_id: 'sf2ce' },
  implementation_path: { implementation_id: 'jt51', path: 'hdl/jt51.v', is_top: 1 },
  implementation_platform: { implementation_id: 'mister-arcade-cps1', platform_id: 'mister' },
  implementation_system: { implementation_id: 'mister-arcade-cps1', system_id: 'capcom-cps1' },
  license: {
    license_id: 'GPL-3.0-only',
    name: 'GNU General Public License v3.0 only',
    url: 'https://spdx.org/licenses/GPL-3.0-only.html',
    is_osi_approved: 1,
  },
  machine: {
    machine_id: 'shinobi',
    name: 'Shinobi (set 6, System 16A)',
    mame_sourcefile: 'sega/system16a.cpp',
    mame_year: '19??',
    mame_manufacturer: 'Sega',
    driver_status: 'good',
    is_bios: 0,
    is_device: 0,
    is_mechanical: 0,
  },
  machine_chip: {
    machine_id: 'shinobi',
    mame_tag: 'maincpu',
    chip_id: 'm68000',
    clock_hz: 10000000,
    quantity: 1,
  },
  machine_chip_correction: {
    machine_id: 'shinobi',
    mame_tag: 'maincpu',
    chip_id: 'm68000',
    op: 'set',
    clock_hz: 10000000,
    reason: 'The service manual gives 10 MHz; MAME models 8.',
    source_url: 'https://example.org/system16a-service-manual.pdf',
  },
  machine_correction: {
    machine_id: 'shinobi',
    name: 'Shinobi (World)',
    year: 1987,
    manufacturer_id: 'sega',
    reason: 'MAME records the year as 19??.',
  },
  machine_system: {
    machine_id: 'shinobi',
    system_id: 'sega-system16a',
    reason: 'One driver .cpp, two boards; this title is the System 16A one.',
  },
  machine_unmapped_device: { machine_id: 'shinobi', mame_device: 'sega_315_5195', quantity: 1 },
  mame_device: { mame_device: 'ym2151', chip_id: 'ym2151', note: 'Yamaha OPM.' },
  manufacturer: { manufacturer_id: 'yamaha', name: 'Yamaha', country: 'JP' },
  manufacturer_alias: { alias: 'Sega Enterprises, Ltd.', manufacturer_id: 'sega' },
  project: {
    project_id: 'jotego',
    name: 'JOTEGO',
    url: 'https://github.com/jotego',
    author: 'Jose Tejada',
  },
  system: {
    system_id: 'sega-system16a',
    name: 'Sega System 16A',
    kind_id: 'arcade',
    manufacturer_id: 'sega',
    year_introduced: 1985,
  },
  system_chip: {
    system_id: 'sega-system16a',
    role_id: 'sound',
    chip_id: 'ym2151',
    quantity: 1,
    clock_hz: 4000000,
  },
  system_driver: { mame_sourcefile: 'sega/system16a.cpp', system_id: 'sega-system16a' },
  system_kind: { kind_id: 'arcade', label: 'Arcade' },
  system_name: { system_id: 'capcom-cps1', name: 'Capcom Play System', kind: 'alias' },
};

interface Invalid {
  readonly table: string;
  readonly why: string;
  /** Exactly one change from `VALID[table]`. */
  readonly change: Readonly<Record<string, unknown>>;
  /** Property names to delete from the valid row. */
  readonly remove?: readonly string[];
  readonly keyword: string;
  readonly at: string;
}

/** One targeted violation per table, each isolating a single constraint. */
const INVALID: readonly Invalid[] = [
  {
    table: 'accuracy_level',
    why: 'a capitalised lookup key',
    change: { accuracy_id: 'Gate-Level' },
    keyword: 'pattern',
    at: '/accuracy_id',
  },
  {
    table: 'chip',
    why: 'a year before integrated circuits existed',
    change: { year_introduced: 1849 },
    keyword: 'minimum',
    at: '/year_introduced',
  },
  {
    table: 'chip_datasheet',
    why: 'a relative datasheet link',
    change: { url: 'ym2151.pdf' },
    keyword: 'pattern',
    at: '/url',
  },
  {
    table: 'chip_equivalence',
    why: 'a third relation',
    change: { kind: 'similar' },
    keyword: 'enum',
    at: '/kind',
  },
  {
    table: 'chip_family',
    why: 'an uppercase family id',
    change: { family_id: 'OPM' },
    keyword: 'pattern',
    at: '/family_id',
  },
  {
    table: 'chip_function',
    why: 'a prospector band outside the taxonomy',
    change: { prospector_band: 'impossible' },
    keyword: 'enum',
    at: '/prospector_band',
  },
  {
    table: 'chip_name',
    why: 'a name kind that is neither alias nor retired id',
    change: { kind: 'nickname' },
    keyword: 'enum',
    at: '/kind',
  },
  {
    table: 'chip_role',
    why: 'an underscore in a slug',
    change: { role_id: 'audio_cpu' },
    keyword: 'pattern',
    at: '/role_id',
  },
  {
    table: 'dataset_meta',
    why: 'a screaming meta key',
    change: { key: 'MAME_VERSION' },
    keyword: 'pattern',
    at: '/key',
  },
  {
    table: 'fpga_platform',
    why: 'a display name used as a key',
    change: { platform_id: 'MiSTer' },
    keyword: 'pattern',
    at: '/platform_id',
  },
  {
    table: 'hdl_language',
    why: 'a space in a slug',
    change: { language_id: 'system verilog' },
    keyword: 'pattern',
    at: '/language_id',
  },
  {
    table: 'implementation',
    why: 'a review date that is not ISO 8601',
    change: { last_reviewed: '2026/01/15' },
    keyword: 'pattern',
    at: '/last_reviewed',
  },
  {
    table: 'implementation_chip',
    why: 'an uppercase chip id',
    change: { chip_id: 'YM2151' },
    keyword: 'pattern',
    at: '/chip_id',
  },
  {
    table: 'implementation_dependency',
    why: 'a space in an implementation id',
    change: { provider_id: 'jt 51' },
    keyword: 'pattern',
    at: '/provider_id',
  },
  {
    table: 'implementation_kind',
    why: 'a space where the identifier grammar wants a separator',
    change: { kind_id: 'fpga hdl' },
    keyword: 'pattern',
    at: '/kind_id',
  },
  {
    table: 'implementation_machine',
    why: 'a capitalised MAME shortname',
    change: { machine_id: 'SF2CE' },
    keyword: 'pattern',
    at: '/machine_id',
  },
  {
    table: 'implementation_path',
    why: 'a boolean column holding 2',
    change: { is_top: 2 },
    keyword: 'enum',
    at: '/is_top',
  },
  {
    table: 'implementation_platform',
    why: 'an empty platform id',
    change: { platform_id: '' },
    keyword: 'pattern',
    at: '/platform_id',
  },
  {
    table: 'implementation_system',
    why: 'a display name used as a system id',
    change: { system_id: 'Capcom CPS-1' },
    keyword: 'pattern',
    at: '/system_id',
  },
  {
    table: 'license',
    why: 'a JSON boolean where SQLite has none',
    change: { is_osi_approved: true },
    keyword: 'type',
    at: '/is_osi_approved',
  },
  {
    table: 'machine',
    why: 'a Windows-style driver source path',
    change: { mame_sourcefile: 'sega\\system16a.cpp' },
    keyword: 'pattern',
    at: '/mame_sourcefile',
  },
  {
    table: 'machine_chip',
    why: 'a MAME tag with the leading colon left on',
    change: { mame_tag: ':maincpu' },
    keyword: 'pattern',
    at: '/mame_tag',
  },
  {
    table: 'machine_chip_correction',
    why: 'a set correction that sets nothing',
    change: { op: 'set' },
    remove: ['clock_hz'],
    keyword: 'anyOf',
    at: '',
  },
  {
    table: 'machine_correction',
    why: 'an implausible year',
    change: { year: 2999 },
    keyword: 'maximum',
    at: '/year',
  },
  {
    table: 'machine_system',
    why: 'a blank provenance note, which is optional but not blankable',
    change: { reason: '   ' },
    keyword: 'pattern',
    at: '/reason',
  },
  {
    table: 'machine_unmapped_device',
    why: 'a quantity of zero',
    change: { quantity: 0 },
    keyword: 'minimum',
    at: '/quantity',
  },
  {
    table: 'mame_device',
    why: 'a device that is both mapped and ignored',
    change: { ignore_reason: 'screen' },
    keyword: 'oneOf',
    at: '',
  },
  {
    table: 'manufacturer',
    why: 'a country name instead of an ISO code',
    change: { country: 'Japan' },
    keyword: 'pattern',
    at: '/country',
  },
  {
    table: 'manufacturer_alias',
    why: 'a manufacturer display name used as a key',
    change: { manufacturer_id: 'Sega' },
    keyword: 'pattern',
    at: '/manufacturer_id',
  },
  {
    table: 'project',
    why: 'a scheme-less repository URL',
    change: { url: 'github.com/jotego' },
    keyword: 'pattern',
    at: '/url',
  },
  {
    table: 'system',
    why: 'a capitalised system kind',
    change: { kind_id: 'Arcade' },
    keyword: 'pattern',
    at: '/kind_id',
  },
  {
    table: 'system_chip',
    why: 'a quantity of zero',
    change: { quantity: 0 },
    keyword: 'minimum',
    at: '/quantity',
  },
  {
    table: 'system_driver',
    why: 'a driver header instead of a driver source file',
    change: { mame_sourcefile: 'sega/system16a.h' },
    keyword: 'pattern',
    at: '/mame_sourcefile',
  },
  {
    table: 'system_kind',
    why: 'an uppercase kind id',
    change: { kind_id: 'ARCADE' },
    keyword: 'pattern',
    at: '/kind_id',
  },
  {
    table: 'system_name',
    why: 'a retired id that is not shaped like an id',
    change: { name: 'Capcom Play System', kind: 'retired_id' },
    keyword: 'pattern',
    at: '/name',
  },
];

let ajv: Ajv2020;
let tables: string[];

/** The compiled validator for a schema `$id`, or a failure that names the missing one. */
function validator(name: string): ValidateFunction {
  const validate = ajv.getSchema(`${SCHEMA_ID}${name}.schema.json`);
  if (validate === undefined) throw new Error(`no compiled schema for ${name}`);
  return validate;
}

/** A fixture row, or a failure that names the missing table. */
function valid(table: string): Row {
  const row = VALID[table];
  if (row === undefined) throw new Error(`no valid fixture for ${table}`);
  return row;
}

/** The valid row with `change` applied and `remove` omitted — never a mutation. */
function mutate(
  table: string,
  change: Readonly<Record<string, unknown>>,
  remove: readonly string[] = [],
): Record<string, unknown> {
  const dropped = new Set(remove);
  return Object.fromEntries(
    Object.entries({ ...valid(table), ...change }).filter(([key]) => !dropped.has(key)),
  );
}

/** The last NOT NULL column without a default, per the schema's own `required` list. */
function lastRequired(table: string): string {
  const schema = JSON.parse(readFileSync(join(SCHEMAS_DIR, `${table}.schema.json`), 'utf8')) as {
    required: string[];
  };
  const name = schema.required.at(-1);
  if (name === undefined) throw new Error(`${table} declares no required property`);
  return name;
}

function expectRejected(
  validate: ValidateFunction,
  value: unknown,
  keyword: string,
  at: string,
): void {
  expect(validate(value)).toBe(false);
  const errors: ErrorObject[] = validate.errors ?? [];
  const hit = errors.some((error) => error.keyword === keyword && error.instancePath === at);
  expect(hit, `expected keyword '${keyword}' at '${at}', got ${JSON.stringify(errors)}`).toBe(true);
}

beforeAll(() => {
  ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  for (const file of discoverRowFiles([SCHEMAS_DIR])) {
    ajv.addSchema(JSON.parse(readFileSync(file, 'utf8')) as object);
  }
  const db = createSchemaDatabase();
  tables = listTables(db).filter((table) => !TABLES_WITHOUT_ROW_FILES.includes(table));
  db.close();
});

describe('the JSON Schemas agree with the DDL', () => {
  it('reports no drift in any table', () => {
    const db = createSchemaDatabase();
    expect(diffRowSchemas(db, SCHEMAS_DIR)).toEqual([]);
    db.close();
  });

  it('actually reports drift when a schema and the DDL disagree', () => {
    // A guard nobody has watched fail is not a guard. Three independent kinds of drift,
    // each introduced into a throwaway copy of schemas/.
    const dir = mkdtempSync(join(tmpdir(), 'bomsquad-drift-'));
    try {
      cpSync(SCHEMAS_DIR, dir, { recursive: true });
      const path = join(dir, 'chip.schema.json');
      const doc = JSON.parse(readFileSync(path, 'utf8')) as {
        required: string[];
        properties: Record<string, unknown>;
      };
      doc.properties['invented_column'] = { type: 'string' };
      doc.required.push('package');
      writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');
      rmSync(join(dir, 'system_kind.schema.json'));

      const db = createSchemaDatabase();
      const drift = diffRowSchemas(db, dir);
      db.close();

      expect(drift).toContainEqual({
        subject: 'chip',
        detail: "property 'invented_column' has no column",
      });
      expect(
        drift.some((entry) => entry.subject === 'chip' && entry.detail.startsWith('required')),
      ).toBe(true);
      expect(drift).toContainEqual({
        subject: 'system_kind',
        detail: 'no schemas/system_kind.schema.json',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a drifted type or pattern, which a name-and-order check could not see', () => {
    // MINOR 9's drift class: the property keeps its name and its position, and only its
    // grammar or its type moves. Both edits below used to pass silently.
    const dir = mkdtempSync(join(tmpdir(), 'bomsquad-drift-'));
    try {
      cpSync(SCHEMAS_DIR, dir, { recursive: true });

      const role = join(dir, 'chip_role.schema.json');
      const roleDoc = JSON.parse(readFileSync(role, 'utf8')) as {
        properties: Record<string, unknown>;
      };
      // A slug column given the identifier grammar: same name, same slot, wrong alphabet.
      roleDoc.properties['role_id'] = { type: 'string', pattern: '^[a-z0-9_]+$' };
      writeFileSync(role, JSON.stringify(roleDoc, null, 2) + '\n');

      const machine = join(dir, 'machine.schema.json');
      const machineDoc = JSON.parse(readFileSync(machine, 'utf8')) as {
        properties: Record<string, unknown>;
      };
      machineDoc.properties['clone_count'] = { type: 'string' };
      writeFileSync(machine, JSON.stringify(machineDoc, null, 2) + '\n');

      const db = createSchemaDatabase();
      const drift = diffRowSchemas(db, dir);
      db.close();

      expect(drift).toContainEqual({
        subject: 'machine',
        detail: "clone_count is INTEGER in the DDL but type 'string' in the schema",
      });
      const grammar = drift.find((entry) => entry.subject === 'common.schema.json');
      expect(grammar?.detail).toMatch(/columns with one DDL CHECK carry 2 patterns/);
      expect(grammar?.detail).toContain('chip_role.role_id');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a grammar-constrained column that declares no pattern at all', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bomsquad-drift-'));
    try {
      cpSync(SCHEMAS_DIR, dir, { recursive: true });
      const path = join(dir, 'implementation_path.schema.json');
      const doc = JSON.parse(readFileSync(path, 'utf8')) as { properties: Record<string, unknown> };
      doc.properties['path'] = { type: 'string' };
      writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');

      const db = createSchemaDatabase();
      const drift = diffRowSchemas(db, dir);
      db.close();

      expect(drift).toContainEqual({
        subject: 'implementation_path',
        detail: 'path has a shape CHECK but no pattern',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('covers every table that has a row file, and only those', () => {
    expect(Object.keys(VALID).sort(compareBytes)).toEqual(tables);
  });

  it('has a targeted invalid fixture for every table', () => {
    expect([...new Set(INVALID.map((invalid) => invalid.table))].sort(compareBytes)).toEqual(
      tables,
    );
  });

  it('compiles the quality report schema too', () => {
    const validate = validator('quality-report');
    expect(
      validate({
        counts: { chip: 78, implementation: 41, machine: 12043, project: 9, system: 22 },
        dataset_version: '0.0.0-dev',
        db_bytes: 11534336,
        devices: { ignored: 2, mapped: 3, unmapped: 2 },
        instances: { mapped: 7, mapped_instance_share: 0.7778, total: 9, unmapped: 2 },
        mame_version: '0.288',
        schema_version: '2.0.0',
        threshold_version: '2.0.0',
        warnings_by_code: { CHIP_MISSING_METADATA: 2, IMPL_UNVERIFIED_LICENSE: 2 },
      }),
    ).toBe(true);
    expect(validate({ counts: {}, warnings_by_code: { NOT_A_CODE: 1 } })).toBe(false);
  });
});

describe('valid fixtures', () => {
  for (const [table, row] of Object.entries(VALID)) {
    it(`${table} accepts a well-formed row`, () => {
      const validate = validator(table);
      expect(validate(row), JSON.stringify(validate.errors)).toBe(true);
    });
  }
});

describe('invalid fixtures, one violation each', () => {
  for (const [table, row] of Object.entries(VALID)) {
    it(`${table} rejects an unknown column`, () => {
      expectRejected(validator(table), { ...row, not_a_column: 'x' }, 'additionalProperties', '');
    });

    it(`${table} rejects a row missing a NOT NULL column`, () => {
      const dropped = lastRequired(table);
      expectRejected(validator(table), mutate(table, {}, [dropped]), 'required', '');
    });
  }

  for (const invalid of INVALID) {
    it(`${invalid.table} rejects ${invalid.why}`, () => {
      expectRejected(
        validator(invalid.table),
        mutate(invalid.table, invalid.change, invalid.remove ?? []),
        invalid.keyword,
        invalid.at,
      );
    });
  }
});

describe('the row-file envelope', () => {
  it('accepts a bundle whose keys are table names', () => {
    const validate = validator('rowfile');
    expect(
      validate({
        system: [valid('system')],
        system_name: [{ system_id: 'sega-system16a', name: 'System 16A', kind: 'alias' }],
        system_driver: [valid('system_driver')],
        system_chip: [valid('system_chip')],
      }),
      JSON.stringify(validate.errors),
    ).toBe(true);
  });

  it('rejects a key that is not a table name', () => {
    expect(validator('rowfile')({ chips: [valid('chip')] })).toBe(false);
  });

  it('accepts the curated lookup file that already exists in data/', () => {
    const validate = validator('rowfile');
    const file: unknown = JSON.parse(
      readFileSync(join(REPO_ROOT, 'data', 'lookup', 'chip_function.json'), 'utf8'),
    );
    expect(validate(file), JSON.stringify(validate.errors)).toBe(true);
  });
});

describe('reading row files', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'bomsquad-rowfiles-'));
    mkdirSync(join(dir, 'data', 'lookup'), { recursive: true });
    mkdirSync(join(dir, 'data', 'system'), { recursive: true });
    mkdirSync(join(dir, 'extract'), { recursive: true });
    writeFileSync(join(dir, 'data', 'README.md'), 'not a row file\n');
    writeFileSync(
      join(dir, 'data', 'lookup', 'chip_role.json'),
      JSON.stringify({ chip_role: [valid('chip_role')] }, null, 2) + '\n',
    );
    writeFileSync(
      join(dir, 'data', 'lookup', 'manufacturer.json'),
      JSON.stringify({ manufacturer: [{ manufacturer_id: 'sega', name: 'Sega' }] }, null, 2) + '\n',
    );
    writeFileSync(
      join(dir, 'data', 'system', 'sega-system16a.json'),
      JSON.stringify({ system_kind: [valid('system_kind')], system: [valid('system')] }, null, 2) +
        '\n',
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds every .json under the roots, bytewise sorted, and nothing else', () => {
    const found = discoverRowFiles([join(dir, 'data'), join(dir, 'extract')]);
    expect(found).toEqual([
      join(dir, 'data', 'lookup', 'chip_role.json'),
      join(dir, 'data', 'lookup', 'manufacturer.json'),
      join(dir, 'data', 'system', 'sega-system16a.json'),
    ]);
  });

  it('tolerates a root that does not exist yet', () => {
    expect(discoverRowFiles([join(dir, 'nope')])).toEqual([]);
  });

  it('parses a bundle into table fragments', () => {
    const file = readRowFile(join(dir, 'data', 'system', 'sega-system16a.json'));
    expect([...file.tables.keys()]).toEqual(['system_kind', 'system']);
    expect(file.tables.get('system')).toEqual([valid('system')]);
  });

  it('rejects an explicit null instead of an omitted column', () => {
    const path = join(dir, 'bad-null.json');
    writeFileSync(path, JSON.stringify({ chip_role: [{ role_id: 'sound', label: null }] }));
    expect(() => readRowFile(path)).toThrow(/is null; omit unknown columns instead/);
    rmSync(path);
  });

  it('rejects a nested array, which is the 1NF smell the rebuild deleted', () => {
    const path = join(dir, 'bad-array.json');
    writeFileSync(path, JSON.stringify({ chip: [{ chip_id: 'z80', names: ['Z80', 'Z-80'] }] }));
    expect(() => readRowFile(path)).toThrow(/is an array; rows are flat/);
    rmSync(path);
  });

  it('rejects a nested object', () => {
    const path = join(dir, 'bad-object.json');
    writeFileSync(
      path,
      JSON.stringify({ machine: [{ machine_id: 'x', coverage: { percent: 50 } }] }),
    );
    expect(() => readRowFile(path)).toThrow(/is object; rows are flat/);
    rmSync(path);
  });

  it('rejects a file whose top level is not a table map', () => {
    const path = join(dir, 'bad-top.json');
    writeFileSync(path, JSON.stringify([valid('chip')]));
    expect(() => readRowFile(path)).toThrow(/must be a JSON object keyed by table name/);
    rmSync(path);
  });

  it('loads a discovered dataset end to end', () => {
    const db = createSchemaDatabase();
    const result = loadDataset(db, [join(dir, 'data'), join(dir, 'extract')]);
    expect(result.total).toBe(4);
    expect(result.rowCounts.get('system')).toBe(1);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  });

  it('refuses a bundle key that is not a table', () => {
    const db = createSchemaDatabase();
    expect(() => {
      loadRowFiles(db, [
        { path: 'fixture://bad.json', tables: new Map([['chips', [valid('chip')]]]) },
      ]);
    }).toThrow(/'chips' is not a table in this schema/);
    db.close();
  });
});

describe('the loader is deterministic', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'bomsquad-determinism-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function build(name: string, reversed: boolean): string {
    const path = join(dir, name);
    const files = canonicalQueryFixture().map((file) => ({
      path: file.path,
      tables: new Map(
        [...file.tables].map(([table, rows]) => [table, reversed ? [...rows].reverse() : rows]),
      ),
    }));
    const db = new DatabaseSync(path);
    applySchema(db);
    loadRowFiles(db, reversed ? [...files].reverse() : files);
    db.exec('PRAGMA journal_mode = DELETE; ANALYZE; VACUUM;');
    db.close();
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  }

  it('produces a byte-identical database from shuffled inputs', () => {
    // Standing rule 2: same inputs, byte-identical outputs. Row order inside a file and
    // file order within the dataset are both inputs the curator does not control, so
    // neither may reach the output.
    expect(build('forward.sqlite', false)).toBe(build('reversed.sqlite', true));
  });
});
