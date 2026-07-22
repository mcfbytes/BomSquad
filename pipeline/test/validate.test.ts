/**
 * Tests for `pipeline validate`.
 *
 * Two styles, deliberately:
 *
 * - the lint rules of `src/validate/rules.ts` are pure, so they are driven from literal
 *   `SourceFile` values — one passing and one failing case each, asserting the file, the
 *   row key, the column and the rule id on every failing case;
 * - the three-layer orchestration is driven from fixture *trees* under `test/fixtures/`,
 *   because filename rules, byte-level formatting and an empty dataset are properties of
 *   a directory, not of an object.
 *
 * Nothing here writes to the real `data/` tree, and no fixture lives there.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { applySchema } from '../src/db/schema.js';
import { describeTables } from '../src/db/introspect.js';
import { validate } from '../src/validate/index.js';
import {
  canonicalJson,
  lintFile,
  LINT_RULES,
  QUALITY_WARNING_CODES,
  ruleClockRange,
  ruleFilenameKey,
  ruleJsonFormat,
  ruleRowKeyOrder,
  ruleRowOrder,
  ruleTableKeyOrder,
  ruleYearRange,
  type Diagnostic,
  type Schema,
  type SourceFile,
} from '../src/validate/rules.js';
import {
  countBySeverity,
  failed,
  formatDiagnostic,
  formatJson,
  formatReport,
  sortDiagnostics,
} from '../src/validate/report.js';
import type { Row } from '../src/db/rowfiles.js';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const BUILD_DATE = '2026-01-01';

function liveSchema(): Schema {
  const db = new DatabaseSync(':memory:');
  applySchema(db);
  const schema: Schema = new Map(describeTables(db).map((info) => [info.name, info]));
  db.close();
  return schema;
}

const SCHEMA = liveSchema();

/** Builds a SourceFile whose text is exactly the canonical rendering of its rows. */
function source(
  relativePath: string,
  tables: Readonly<Record<string, readonly Row[]>>,
): SourceFile {
  const partial: SourceFile = {
    path: `/fixtures/${relativePath}`,
    relativePath,
    text: '',
    tables: new Map(Object.entries(tables)),
  };
  return { ...partial, text: canonicalJson(partial, SCHEMA) };
}

/** Builds a SourceFile with verbatim text, for the formatting rule. */
function rawSource(
  relativePath: string,
  tables: Readonly<Record<string, readonly Row[]>>,
  text: string,
): SourceFile {
  return {
    path: `/fixtures/${relativePath}`,
    relativePath,
    text,
    tables: new Map(Object.entries(tables)),
  };
}

const CHIP: Row = {
  chip_id: 'ym2151',
  display_name: 'YM2151',
  function_id: 'sound-fm',
  manufacturer_id: 'yamaha',
  description: 'Eight-channel four-operator FM synthesizer.',
  typical_clock_hz: 3_579_545,
  year_introduced: 1984,
};

function only(diagnostics: readonly Diagnostic[]): Diagnostic {
  expect(diagnostics).toHaveLength(1);
  const first = diagnostics[0];
  if (first === undefined) throw new Error('unreachable');
  return first;
}

/** Asserts presence and narrows, so no test needs a non-null assertion. */
function must(diagnostic: Diagnostic | undefined): Diagnostic {
  expect(diagnostic).toBeDefined();
  if (diagnostic === undefined) throw new Error('unreachable');
  return diagnostic;
}

/** Every diagnostic must be actionable: file, key, column, rule and a fix. */
function expectActionable(candidate: Diagnostic | undefined, expected: Partial<Diagnostic>): void {
  const diagnostic = must(candidate);
  expect(diagnostic.file).not.toBe('');
  expect(diagnostic.rule).not.toBe('');
  expect(diagnostic.message).not.toBe('');
  expect(diagnostic.fix.length).toBeGreaterThan(20);
  expect(diagnostic).toMatchObject(expected);
}

// ---------------------------------------------------------------------------
// rules — one passing and one failing case each
// ---------------------------------------------------------------------------

describe('filename-key', () => {
  it('passes when the stem is the entity key and every row carries it', () => {
    const file = source('data/chip/ym2151.json', {
      chip: [CHIP],
      chip_name: [{ chip_id: 'ym2151', name: 'OPM', kind: 'alias' }],
    });
    expect(ruleFilenameKey(file, SCHEMA)).toEqual([]);
  });

  it('fails when the declared key differs from the filename stem', () => {
    const file = source('data/chip/opm.json', { chip: [CHIP] });
    expectActionable(only(ruleFilenameKey(file, SCHEMA)), {
      severity: 'ERROR',
      file: 'data/chip/opm.json',
      table: 'chip',
      key: 'ym2151',
      column: 'chip_id',
      rule: 'filename-key',
    });
  });

  it('fails when a child row belongs to a different entity', () => {
    const file = source('data/chip/ym2151.json', {
      chip: [CHIP],
      chip_name: [{ chip_id: 'ym2203', name: 'OPN', kind: 'alias' }],
    });
    expectActionable(only(ruleFilenameKey(file, SCHEMA)), {
      table: 'chip_name',
      key: 'ym2203/OPN',
      column: 'chip_id',
      rule: 'filename-key',
    });
  });

  it('does not apply to a file with no entity table', () => {
    const file = source('data/lookup/system_kind.json', {
      system_kind: [{ kind_id: 'arcade', label: 'Arcade system board' }],
    });
    expect(ruleFilenameKey(file, SCHEMA)).toEqual([]);
  });
});

describe('table-key-order', () => {
  it('passes with the entity table first, then bytewise ascending', () => {
    const file = source('data/chip/ym2151.json', {
      chip: [CHIP],
      chip_datasheet: [
        { chip_id: 'ym2151', url: 'https://example.org/ym2151.pdf', title: 'YM2151 datasheet' },
      ],
      chip_name: [{ chip_id: 'ym2151', name: 'OPM', kind: 'alias' }],
    });
    expect(ruleTableKeyOrder(file, SCHEMA)).toEqual([]);
  });

  it('fails when the entity table is not first', () => {
    const file = source('data/chip/ym2151.json', {
      chip_name: [{ chip_id: 'ym2151', name: 'OPM', kind: 'alias' }],
      chip: [CHIP],
    });
    expectActionable(only(ruleTableKeyOrder(file, SCHEMA)), {
      rule: 'table-key-order',
      file: 'data/chip/ym2151.json',
    });
  });
});

describe('row-key-order', () => {
  it('passes when keys follow DDL column order', () => {
    expect(ruleRowKeyOrder(source('data/chip/ym2151.json', { chip: [CHIP] }), SCHEMA)).toEqual([]);
  });

  it('fails when two keys are transposed, naming the first wrong column', () => {
    const scrambled: Row = {
      chip_id: 'ym2151',
      function_id: 'sound-fm',
      display_name: 'YM2151',
    };
    const file = source('data/chip/ym2151.json', { chip: [scrambled] });
    expectActionable(only(ruleRowKeyOrder(file, SCHEMA)), {
      table: 'chip',
      key: 'ym2151',
      column: 'function_id',
      rule: 'row-key-order',
    });
  });
});

describe('row-order', () => {
  const sorted: readonly Row[] = [
    { manufacturer_id: 'sega', name: 'Sega' },
    { manufacturer_id: 'yamaha', name: 'Yamaha' },
  ];

  it('passes when rows are sorted bytewise by primary key', () => {
    const file = source('data/lookup/manufacturer.json', { manufacturer: sorted });
    expect(ruleRowOrder(file, SCHEMA)).toEqual([]);
  });

  it('fails when rows are out of order', () => {
    const file = rawSource(
      'data/lookup/manufacturer.json',
      { manufacturer: [...sorted].reverse() },
      '',
    );
    expectActionable(only(ruleRowOrder(file, SCHEMA)), {
      table: 'manufacturer',
      key: 'sega',
      column: 'manufacturer_id',
      rule: 'row-order',
    });
  });
});

describe('json-format', () => {
  const tables = { chip: [CHIP] };

  it('passes on canonical bytes', () => {
    expect(ruleJsonFormat(source('data/chip/ym2151.json', tables), SCHEMA)).toEqual([]);
  });

  it('fails without a trailing newline', () => {
    const text = JSON.stringify({ chip: [CHIP] }, null, 2);
    const diagnostic = only(
      ruleJsonFormat(rawSource('data/chip/ym2151.json', tables, text), SCHEMA),
    );
    expectActionable(diagnostic, { rule: 'json-format' });
    expect(diagnostic.message).toBe('file has no trailing newline');
  });

  it('fails on four-space indentation', () => {
    const text = `${JSON.stringify({ chip: [CHIP] }, null, 4)}\n`;
    const diagnostic = only(
      ruleJsonFormat(rawSource('data/chip/ym2151.json', tables, text), SCHEMA),
    );
    expect(diagnostic.message).toMatch(/^differs from canonical form at line \d+$/);
  });

  it('fails on CRLF newlines', () => {
    const text = `${JSON.stringify({ chip: [CHIP] }, null, 2)}\n`.replaceAll('\n', '\r\n');
    expect(
      only(ruleJsonFormat(rawSource('data/chip/ym2151.json', tables, text), SCHEMA)).message,
    ).toBe('file uses CRLF newlines');
  });
});

describe('clock-range', () => {
  it('passes on a plausible clock', () => {
    const file = source('data/system/x.json', {
      system_chip: [{ system_id: 'x', role_id: 'sound', chip_id: 'ym2151', clock_hz: 3_579_545 }],
    });
    expect(ruleClockRange(file, SCHEMA)).toEqual([]);
  });

  it('warns when megahertz were written as hertz', () => {
    const file = source('data/system/x.json', {
      system_chip: [{ system_id: 'x', role_id: 'sound', chip_id: 'ym2151', clock_hz: 4 }],
    });
    expectActionable(only(ruleClockRange(file, SCHEMA)), {
      severity: 'WARN',
      table: 'system_chip',
      key: 'x/sound/ym2151',
      column: 'clock_hz',
      rule: 'clock-range',
    });
  });

  it('warns above 1 GHz too, on chip.typical_clock_hz', () => {
    const file = source('data/chip/ym2151.json', {
      chip: [{ ...CHIP, typical_clock_hz: 3_579_545_000 }],
    });
    expectActionable(only(ruleClockRange(file, SCHEMA)), {
      severity: 'WARN',
      column: 'typical_clock_hz',
      rule: 'clock-range',
    });
  });
});

describe('year-range', () => {
  it('passes inside the band', () => {
    expect(ruleYearRange(source('data/chip/ym2151.json', { chip: [CHIP] }), SCHEMA)).toEqual([]);
  });

  it('warns outside the band without being an error', () => {
    const file = source('data/chip/ym2151.json', { chip: [{ ...CHIP, year_introduced: 2019 }] });
    expectActionable(only(ruleYearRange(file, SCHEMA)), {
      severity: 'WARN',
      table: 'chip',
      key: 'ym2151',
      column: 'year_introduced',
      rule: 'year-range',
    });
  });

  it('accepts values the DDL accepts but the band rejects, as a warning only', () => {
    const file = source('data/chip/ym2151.json', { chip: [{ ...CHIP, year_introduced: 1955 }] });
    expect(only(ruleYearRange(file, SCHEMA)).severity).toBe('WARN');
  });
});

describe('the rule registry', () => {
  it('has unique ids and runs every rule from lintFile', () => {
    const ids = LINT_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    const file = source('data/chip/ym2151.json', { chip: [CHIP] });
    expect(lintFile(file, SCHEMA)).toEqual([]);
  });

  it('classifies exactly the structural rules as ERROR', () => {
    const errors = LINT_RULES.filter((rule) => rule.severity === 'ERROR').map((rule) => rule.id);
    const warnings = LINT_RULES.filter((rule) => rule.severity === 'WARN').map((rule) => rule.id);
    expect(errors).toEqual([
      'filename-key',
      'table-key-order',
      'row-key-order',
      'row-order',
      'json-format',
    ]);
    expect(warnings).toEqual(['clock-range', 'year-range']);
  });

  it('knows every code v_quality_warning can emit', () => {
    const db = new DatabaseSync(':memory:');
    applySchema(db);
    const sql = String(
      db
        .prepare("SELECT sql FROM sqlite_schema WHERE type = 'view' AND name = 'v_quality_warning'")
        .get()?.['sql'],
    );
    db.close();
    for (const code of QUALITY_WARNING_CODES) expect(sql).toContain(`'${code}'`);
    // Every code the view can emit is also a code the reporter can name a file for.
    const emitted = [...sql.matchAll(/SELECT '([A-Z_]+)'/g)].map((match) => match[1]);
    expect([...new Set(emitted)].sort()).toEqual([...QUALITY_WARNING_CODES]);
    expect(QUALITY_WARNING_CODES).toHaveLength(15);
  });
});

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

describe('report', () => {
  const error: Diagnostic = {
    severity: 'ERROR',
    file: 'data/chip/ym2151.json',
    table: 'chip',
    key: 'ym2151',
    column: 'manufacturer_id',
    rule: 'foreign-key-violation',
    message:
      "manufacturer_id='yamaha-corporation' has no matching manufacturer.manufacturer_id row",
    fix: 'add the missing manufacturer row, or change manufacturer_id to an existing manufacturer.manufacturer_id value',
  };
  const warning: Diagnostic = { ...error, severity: 'WARN', rule: 'year-range', column: 'x' };

  it('names file, row key, column, rule and fix on one diagnostic', () => {
    expect(formatDiagnostic(error)).toBe(
      "ERROR data/chip/ym2151.json: chip[ym2151].manufacturer_id [foreign-key-violation] manufacturer_id='yamaha-corporation' has no matching manufacturer.manufacturer_id row\n" +
        '      fix: add the missing manufacturer row, or change manufacturer_id to an existing manufacturer.manufacturer_id value',
    );
  });

  it('sorts errors before warnings, then deterministically', () => {
    expect(sortDiagnostics([warning, error]).map((d) => d.severity)).toEqual(['ERROR', 'WARN']);
    expect(countBySeverity([warning, error])).toEqual({ errors: 1, warnings: 1 });
  });

  it('fails on an error, and on a warning only under --strict', () => {
    const withWarning = { fileCount: 1, rowCount: 1, diagnostics: [warning] };
    expect(failed(withWarning, { strict: false })).toBe(false);
    expect(failed(withWarning, { strict: true })).toBe(true);
    expect(failed({ fileCount: 1, rowCount: 1, diagnostics: [error] }, { strict: false })).toBe(
      true,
    );
  });

  it('renders an empty dataset without diagnostics', () => {
    expect(formatReport({ fileCount: 0, rowCount: 0, diagnostics: [] }, { strict: false })).toBe(
      '0 files, 0 rows, 0 errors, 0 warnings\n',
    );
  });

  it('emits parseable JSON with bytewise-ascending keys', () => {
    const json = formatJson({ fileCount: 2, rowCount: 3, diagnostics: [error] }, { strict: false });
    const parsed: unknown = JSON.parse(json);
    expect(parsed).toMatchObject({ errors: 1, files: 2, ok: false, rows: 3, warnings: 0 });
    expect(Object.keys(parsed as object)).toEqual([...Object.keys(parsed as object)].sort());
  });
});

// ---------------------------------------------------------------------------
// end to end, over fixture trees
// ---------------------------------------------------------------------------

function run(tree: string) {
  const root = join(FIXTURES, tree);
  return validate({ roots: [root], baseDir: root, buildDate: BUILD_DATE });
}

/**
 * Two fixtures are about *bytes* — non-canonical indentation and malformed JSON — so they
 * cannot be stored on disk: any `prettier --write` over the repository would silently
 * repair them and the tests would pass for the wrong reason. They are written to a temp
 * directory instead, which is still never the real `data/` tree.
 */
function runBytes(files: Readonly<Record<string, string>>) {
  const root = mkdtempSync(join(tmpdir(), 'bomsquad-validate-'));
  for (const [relativePath, text] of Object.entries(files)) {
    const path = join(root, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, 'utf8');
  }
  return validate({ roots: [root], baseDir: root, buildDate: BUILD_DATE });
}

describe('validate over fixture trees', () => {
  it('reports nothing for a clean dataset', () => {
    const result = run('valid');
    expect(result.diagnostics).toEqual([]);
    expect(result.fileCount).toBe(8);
    expect(result.rowCount).toBe(18);
  });

  it('ignores README.md and .gitkeep', () => {
    const entries = readdirSync(join(FIXTURES, 'valid'));
    expect(entries).toContain('README.md');
    expect(entries).toContain('.gitkeep');
    expect(run('valid').fileCount).toBe(8);
  });

  it('handles an empty dataset gracefully', () => {
    const result = run('empty');
    expect(result).toEqual({ fileCount: 0, rowCount: 0, diagnostics: [] });
    expect(failed(result, { strict: true })).toBe(false);
  });

  it('catches a broken foreign key and reports it readably', () => {
    const result = run('broken-fk');
    const diagnostic = only(result.diagnostics);
    expectActionable(diagnostic, {
      severity: 'ERROR',
      file: 'chip/ym2151.json',
      table: 'chip',
      key: 'ym2151',
      column: 'manufacturer_id',
      rule: 'foreign-key-violation',
    });
    expect(diagnostic.message).toBe(
      "manufacturer_id='yamaha-corporation' has no matching manufacturer.manufacturer_id row",
    );
    // Not a bare "FOREIGN KEY constraint failed".
    expect(formatDiagnostic(diagnostic)).not.toMatch(/constraint failed/);
  });

  it('catches a filename that disagrees with the entity key', () => {
    expectActionable(only(run('broken-filename').diagnostics), {
      rule: 'filename-key',
      file: 'chip/z84c00.json',
      key: 'z80',
      column: 'chip_id',
    });
  });

  it('catches non-canonical formatting', () => {
    const chip = readFileSync(join(FIXTURES, 'valid', 'chip', 'z80.json'), 'utf8');
    const result = runBytes({
      'chip/z80.json': JSON.stringify(JSON.parse(chip), null, 4), // 4 spaces, no newline
    });
    expectActionable(only(result.diagnostics.filter((d) => d.rule === 'json-format')), {
      rule: 'json-format',
      file: 'chip/z80.json',
      severity: 'ERROR',
    });
  });

  it('reports the data-quality WARN codes, each against its own file', () => {
    const result = run('broken-quality');
    const byRule = new Map(result.diagnostics.map((d) => [d.rule, d]));
    expect([...byRule.keys()].sort()).toEqual([
      'chip-missing-metadata',
      'impl-stale-review',
      'impl-untargeted',
      'impl-unverified-accuracy',
      'impl-unverified-license',
      'system-no-chips',
    ]);
    for (const diagnostic of result.diagnostics) expect(diagnostic.severity).toBe('WARN');
    expectActionable(byRule.get('chip-missing-metadata'), {
      file: 'chip/ym2151.json',
      table: 'chip',
      key: 'ym2151',
    });
    expectActionable(byRule.get('impl-unverified-license'), {
      file: 'implementation/jt51.json',
      table: 'implementation',
      key: 'jt51',
      column: 'license_id',
    });
    expectActionable(byRule.get('impl-stale-review'), {
      file: 'implementation/jt51.json',
      column: 'last_reviewed',
    });
    expectActionable(byRule.get('system-no-chips'), {
      file: 'system/sega-system1.json',
      table: 'system',
      key: 'sega-system1',
    });
    // warnings alone do not fail a build, but --strict makes them
    expect(failed(result, { strict: false })).toBe(false);
    expect(failed(result, { strict: true })).toBe(true);
  });

  it('is deterministic: two runs produce identical reports', () => {
    const first = formatJson(run('broken-quality'), { strict: false });
    const second = formatJson(run('broken-quality'), { strict: false });
    expect(first).toBe(second);
  });

  it('validates the real data/ tree', () => {
    const result = validate({ buildDate: BUILD_DATE });
    expect(countBySeverity(result.diagnostics).errors).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// SQLite constraint errors, translated
// ---------------------------------------------------------------------------

describe('constraint errors are translated, not passed through', () => {
  it('translates a duplicate primary key into a primary-key-violation', () => {
    const root = join(FIXTURES, 'broken-pk');
    const result = validate({ roots: [root], baseDir: root, buildDate: BUILD_DATE });
    const diagnostic = result.diagnostics.find((d) => d.rule === 'primary-key-violation');
    expectActionable(diagnostic, {
      table: 'manufacturer',
      key: 'sega',
      column: 'manufacturer_id',
      rule: 'primary-key-violation',
    });
  });

  it('translates a CHECK failure into a check-violation naming the column', () => {
    const root = join(FIXTURES, 'broken-check');
    const result = validate({ roots: [root], baseDir: root, buildDate: BUILD_DATE });
    const diagnostic = result.diagnostics.find((d) => d.rule === 'check-violation');
    expectActionable(diagnostic, {
      table: 'chip_name',
      key: 'ym2151/ym2151',
      column: 'chip_id',
    });
    expect(must(diagnostic).message).toContain('name <> chip_id');
  });

  it('reports an unknown top-level key as unknown-table', () => {
    const root = join(FIXTURES, 'broken-table');
    const result = validate({ roots: [root], baseDir: root, buildDate: BUILD_DATE });
    expectActionable(only(result.diagnostics), { rule: 'unknown-table', table: 'chips' });
  });

  it('reports a bad column name through the shape layer', () => {
    const root = join(FIXTURES, 'broken-shape');
    const result = validate({ roots: [root], baseDir: root, buildDate: BUILD_DATE });
    const shape = result.diagnostics.find((d) => d.rule === 'schema-shape');
    expectActionable(shape, { rule: 'schema-shape', table: 'chip' });
  });

  it('reports malformed JSON as json-parse', () => {
    const result = runBytes({ 'chip/bad.json': '{ "chip": [ { "chip_id": "ym2151", } ] }\n' });
    expectActionable(only(result.diagnostics), { rule: 'json-parse', file: 'chip/bad.json' });
  });

  it('reports a null cell as row-shape', () => {
    const root = join(FIXTURES, 'broken-null');
    const result = validate({ roots: [root], baseDir: root, buildDate: BUILD_DATE });
    expectActionable(only(result.diagnostics), { rule: 'row-shape' });
  });
});

// ---------------------------------------------------------------------------
// the fixture trees themselves
// ---------------------------------------------------------------------------

describe('fixtures', () => {
  it('never live under the real data/ tree', () => {
    expect(FIXTURES).toContain(join('pipeline', 'test', 'fixtures'));
    expect(readFileSync(join(FIXTURES, 'README.md'), 'utf8')).toContain('Broken on purpose');
  });
});
