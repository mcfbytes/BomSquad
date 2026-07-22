/**
 * Lint rules — layer 3 of `pipeline validate`.
 *
 * These are the *only* checks written by hand, and each one exists because neither a
 * JSON Schema nor the DDL can express it:
 *
 * - the filename↔key rule and the canonical-form rules are statements about *files*,
 *   and a database has no files;
 * - the clock and year bands are plausibility opinions, deliberately narrower than the
 *   `CHECK` constraints that already reject the impossible values, so they warn rather
 *   than fail.
 *
 * Everything else the v1 validator did is gone: see the deletion ledger in the task
 * report and docs/data-quality.md §2.1. Nothing here re-checks a `FOREIGN KEY`, a
 * `PRIMARY KEY`, a `UNIQUE`, a `CHECK`, a type or an enumeration.
 *
 * Every function is pure: `(SourceFile, schema) => Diagnostic[]`. No I/O, no database,
 * no global state, so each is unit-testable against a literal.
 */
import { compareBytes, type Row } from '../db/rowfiles.js';
import type { TableInfo } from '../db/introspect.js';

export type Severity = 'ERROR' | 'WARN';

/**
 * One finding. Every field that makes a finding actionable is mandatory: which file,
 * which row, which column, which rule, and what to do about it.
 */
export interface Diagnostic {
  readonly severity: Severity;
  /** Repository-relative path, or `(database)` for a whole-dataset finding. */
  readonly file: string;
  /** Table the row belongs to; `''` when the finding is about the file as a whole. */
  readonly table: string;
  /** Primary key of the offending row, columns joined by `/`; `''` when file-wide. */
  readonly key: string;
  /** Offending column; `''` when the finding is about the whole row or file. */
  readonly column: string;
  /** Stable rule identifier, kebab-case. */
  readonly rule: string;
  /** What is wrong, in one sentence. */
  readonly message: string;
  /** What to do about it, concretely. */
  readonly fix: string;
}

/** A parsed row file plus its bytes, which the canonical-form rule needs. */
export interface SourceFile {
  /** Absolute path. */
  readonly path: string;
  /** Repository-relative path — the only form that appears in diagnostics. */
  readonly relativePath: string;
  /** Raw file contents, verbatim. */
  readonly text: string;
  /** Parsed top-level object, in file key order. */
  readonly tables: ReadonlyMap<string, readonly Row[]>;
}

/** Table name → live DDL description, from `describeTables()`. */
export type Schema = ReadonlyMap<string, TableInfo>;

export interface RuleMeta {
  readonly id: string;
  readonly severity: Severity;
  readonly summary: string;
}

/**
 * The per-entity files of data-model.md §4.2 and the column that carries their key.
 * A file containing none of these tables is not a per-entity file (`data/mame_device.json`,
 * `data/lookup/*.json`, `data/correction/*.json`) and the filename rule does not apply.
 */
const ENTITY_TABLES: ReadonlyMap<string, string> = new Map([
  ['chip', 'chip_id'],
  ['system', 'system_id'],
  ['project', 'project_id'],
  ['implementation', 'implementation_id'],
]);

/** Plausibility band for a clock, in hertz: 1 kHz .. 1 GHz. */
export const CLOCK_MIN_HZ = 1_000;
export const CLOCK_MAX_HZ = 1_000_000_000;

/** Plausibility band for a year of introduction. */
export const YEAR_MIN = 1970;
export const YEAR_MAX = 2005;

function stemOf(relativePath: string): string {
  const base = relativePath.slice(relativePath.lastIndexOf('/') + 1);
  return base.endsWith('.json') ? base.slice(0, -'.json'.length) : base;
}

/** The row's primary key, columns in declaration order, joined by `/`. */
export function rowKey(info: TableInfo | undefined, row: Row): string {
  if (info === undefined) return '';
  const parts = info.primaryKey.map((column) => {
    const value = row[column];
    return value === undefined ? '?' : String(value);
  });
  return parts.join('/');
}

/** The entity table this file is named after, if it is a per-entity file. */
function entityTableOf(file: SourceFile): string | undefined {
  for (const table of file.tables.keys()) {
    if (ENTITY_TABLES.has(table)) return table;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// filename-key
// ---------------------------------------------------------------------------

/**
 * data-model.md §4.2: "the filename stem MUST equal the primary key of the file's single
 * entity row, and every row in the file MUST carry that key in its parent column."
 */
export function ruleFilenameKey(file: SourceFile, schema: Schema): Diagnostic[] {
  const entityTable = entityTableOf(file);
  if (entityTable === undefined) return [];
  const keyColumn = ENTITY_TABLES.get(entityTable);
  if (keyColumn === undefined) return [];
  const rows = file.tables.get(entityTable) ?? [];
  const stem = stemOf(file.relativePath);
  const out: Diagnostic[] = [];

  if (rows.length !== 1) {
    out.push({
      severity: 'ERROR',
      file: file.relativePath,
      table: entityTable,
      key: stem,
      column: keyColumn,
      rule: 'filename-key',
      message: `a per-entity file holds exactly one '${entityTable}' row, this one holds ${rows.length}`,
      fix: `split this file so each '${entityTable}' row lives in its own file named <${keyColumn}>.json`,
    });
    return out;
  }

  const declared = rows[0]?.[keyColumn];
  if (declared !== stem) {
    out.push({
      severity: 'ERROR',
      file: file.relativePath,
      table: entityTable,
      key: String(declared ?? ''),
      column: keyColumn,
      rule: 'filename-key',
      message: `${keyColumn} is '${String(declared ?? '')}' but the filename stem is '${stem}'`,
      fix: `rename the file to '${String(declared ?? '')}.json', or set ${keyColumn} to '${stem}'`,
    });
    return out;
  }

  for (const [table, tableRows] of file.tables) {
    const info = schema.get(table);
    if (info === undefined) continue;
    if (!info.columns.some((column) => column.name === keyColumn)) continue;
    for (const row of tableRows) {
      const value = row[keyColumn];
      if (value === undefined || value === stem) continue;
      out.push({
        severity: 'ERROR',
        file: file.relativePath,
        table,
        key: rowKey(info, row),
        column: keyColumn,
        rule: 'filename-key',
        message: `${keyColumn} is '${String(value)}' but this file belongs to '${stem}'`,
        fix: `move this row to data/${entityTable}/${String(value)}.json, or set ${keyColumn} to '${stem}'`,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// canonical form (data-model.md §4.3)
// ---------------------------------------------------------------------------

/** Canonical top-level key order: the entity table first, then the rest bytewise. */
export function canonicalTableOrder(file: SourceFile): string[] {
  const entityTable = entityTableOf(file);
  const rest = [...file.tables.keys()].filter((table) => table !== entityTable).sort(compareBytes);
  return entityTable === undefined ? rest : [entityTable, ...rest];
}

export function ruleTableKeyOrder(file: SourceFile, _schema: Schema): Diagnostic[] {
  const actual = [...file.tables.keys()];
  const expected = canonicalTableOrder(file);
  if (actual.join(',') === expected.join(',')) return [];
  return [
    {
      severity: 'ERROR',
      file: file.relativePath,
      table: actual[0] ?? '',
      key: stemOf(file.relativePath),
      column: '',
      rule: 'table-key-order',
      message: `top-level keys are [${actual.join(', ')}]`,
      fix: `reorder the top-level keys to [${expected.join(', ')}] — the entity table first, then bytewise ascending (data-model.md §4.3)`,
    },
  ];
}

export function ruleRowKeyOrder(file: SourceFile, schema: Schema): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const [table, rows] of file.tables) {
    const info = schema.get(table);
    if (info === undefined) continue;
    const order = info.columns.map((column) => column.name);
    const known = new Set(order);
    for (const row of rows) {
      // Columns the DDL does not have are reported by `unknown-column`; ordering an
      // unknown key is not meaningful, so it does not also fail this rule.
      const present = Object.keys(row).filter((column) => known.has(column));
      const expected = order.filter((column) => present.includes(column));
      if (present.join(',') === expected.join(',')) continue;
      const first = present.find((column, index) => column !== expected[index]) ?? '';
      out.push({
        severity: 'ERROR',
        file: file.relativePath,
        table,
        key: rowKey(info, row),
        column: first,
        rule: 'row-key-order',
        message: `keys are [${present.join(', ')}]`,
        fix: `reorder this row's keys to [${expected.join(', ')}] — DDL column order (data-model.md §4.3)`,
      });
    }
  }
  return out;
}

/** Bytewise for text, numeric for integers. Never locale collation, never `"10" < "9"`. */
function compareRows(info: TableInfo, a: Row, b: Row): number {
  for (const column of info.primaryKey) {
    const x = a[column];
    const y = b[column];
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x < y ? -1 : 1;
      continue;
    }
    const order = compareBytes(String(x ?? ''), String(y ?? ''));
    if (order !== 0) return order;
  }
  return 0;
}

export function ruleRowOrder(file: SourceFile, schema: Schema): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const [table, rows] of file.tables) {
    const info = schema.get(table);
    if (info === undefined) continue;
    for (let index = 1; index < rows.length; index += 1) {
      const previous = rows[index - 1];
      const current = rows[index];
      if (previous === undefined || current === undefined) continue;
      if (compareRows(info, previous, current) <= 0) continue;
      out.push({
        severity: 'ERROR',
        file: file.relativePath,
        table,
        key: rowKey(info, current),
        column: info.primaryKey.join(', '),
        rule: 'row-order',
        message: `sorts before '${rowKey(info, previous)}' but is written after it`,
        fix: `sort '${table}' bytewise ascending by (${info.primaryKey.join(', ')}) (data-model.md §4.3)`,
      });
      break; // one finding per table; the fix is a single sort
    }
  }
  return out;
}

/**
 * Serialises a row file exactly as data-model.md §4.3 requires. The formatting rule is
 * then a byte comparison, which is the only way to cover indentation, escaping and the
 * trailing newline without three more rules.
 */
export function canonicalJson(file: SourceFile, schema: Schema): string {
  const document: Record<string, unknown> = {};
  for (const table of canonicalTableOrder(file)) {
    const info = schema.get(table);
    const rows = [...(file.tables.get(table) ?? [])];
    if (info !== undefined) rows.sort((a, b) => compareRows(info, a, b));
    document[table] = rows.map((row) => {
      const order = info === undefined ? Object.keys(row) : info.columns.map((c) => c.name);
      const canonical: Record<string, unknown> = {};
      for (const column of order) {
        if (column in row) canonical[column] = row[column];
      }
      for (const column of Object.keys(row)) {
        if (!(column in canonical)) canonical[column] = row[column];
      }
      return canonical;
    });
  }
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * Formatting only. Key order and row order have their own rules with better messages,
 * so this one reports only what survives after those are applied — indentation, spacing,
 * escaping, BOM and the trailing newline.
 */
export function ruleJsonFormat(file: SourceFile, schema: Schema): Diagnostic[] {
  const expected = canonicalJson(file, schema);
  if (file.text === expected) return [];
  const detail = describeFormatting(file.text, expected);
  return [
    {
      severity: 'ERROR',
      file: file.relativePath,
      table: [...file.tables.keys()][0] ?? '',
      key: stemOf(file.relativePath),
      column: '',
      rule: 'json-format',
      message: detail,
      fix: 'rewrite the file as JSON.stringify(value, null, 2) plus one trailing newline — UTF-8, no BOM, \\n newlines (data-model.md §4.3)',
    },
  ];
}

function describeFormatting(actual: string, expected: string): string {
  if (actual.startsWith('﻿')) return 'file begins with a UTF-8 BOM';
  if (actual.includes('\r')) return 'file uses CRLF newlines';
  if (!actual.endsWith('\n')) return 'file has no trailing newline';
  if (actual.endsWith('\n\n')) return 'file has more than one trailing newline';
  let line = 1;
  const limit = Math.min(actual.length, expected.length);
  for (let index = 0; index < limit; index += 1) {
    if (actual[index] !== expected[index]) {
      return `differs from canonical form at line ${line}`;
    }
    if (actual[index] === '\n') line += 1;
  }
  return `differs from canonical form at line ${line}`;
}

// ---------------------------------------------------------------------------
// plausibility bands (WARN)
// ---------------------------------------------------------------------------

function isClockColumn(name: string): boolean {
  return name === 'clock_hz' || name.endsWith('_clock_hz');
}

/**
 * WARN, not ERROR: the DDL already rejects `clock_hz <= 0`. This band catches the two
 * mistakes a curator actually makes — writing megahertz where hertz is meant, or adding
 * three zeroes — neither of which is invalid data, only implausible.
 */
export function ruleClockRange(file: SourceFile, schema: Schema): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const [table, rows] of file.tables) {
    const info = schema.get(table);
    if (info === undefined) continue;
    const columns = info.columns.map((column) => column.name).filter(isClockColumn);
    if (columns.length === 0) continue;
    for (const row of rows) {
      for (const column of columns) {
        const value = row[column];
        if (typeof value !== 'number') continue;
        if (value >= CLOCK_MIN_HZ && value <= CLOCK_MAX_HZ) continue;
        const low = value < CLOCK_MIN_HZ;
        out.push({
          severity: 'WARN',
          file: file.relativePath,
          table,
          key: rowKey(info, row),
          column,
          rule: 'clock-range',
          message: `${column} is ${value} Hz, outside the plausible ${CLOCK_MIN_HZ}..${CLOCK_MAX_HZ} Hz band`,
          fix: low
            ? `${column} is in hertz — write ${value} MHz as ${value * 1_000_000}, or confirm the value and leave it`
            : `check for an extra digit: ${Math.round(value / 1000)} would be ${Math.round(value / 1000)} Hz`,
        });
      }
    }
  }
  return out;
}

/**
 * WARN, not ERROR: the DDL allows 1950..2100 because a reissued part legitimately can be
 * dated outside the arcade era. This band flags the era boundary so a typo is visible.
 */
export function ruleYearRange(file: SourceFile, schema: Schema): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const [table, rows] of file.tables) {
    const info = schema.get(table);
    if (info === undefined) continue;
    if (!info.columns.some((column) => column.name === 'year_introduced')) continue;
    for (const row of rows) {
      const value = row['year_introduced'];
      if (typeof value !== 'number') continue;
      if (value >= YEAR_MIN && value <= YEAR_MAX) continue;
      out.push({
        severity: 'WARN',
        file: file.relativePath,
        table,
        key: rowKey(info, row),
        column: 'year_introduced',
        rule: 'year-range',
        message: `year_introduced is ${value}, outside the ${YEAR_MIN}..${YEAR_MAX} band this dataset covers`,
        fix: `confirm ${value} against the datasheet; if the part really is that old or that new, leave it — this is a warning, not a gate`,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

export type LintRule = (file: SourceFile, schema: Schema) => Diagnostic[];

export const LINT_RULES: readonly (RuleMeta & { readonly run: LintRule })[] = [
  {
    id: 'filename-key',
    severity: 'ERROR',
    summary: "filename stem equals the file's entity key, and every row carries it",
    run: ruleFilenameKey,
  },
  {
    id: 'table-key-order',
    severity: 'ERROR',
    summary: 'top-level table keys: entity table first, then bytewise ascending',
    run: ruleTableKeyOrder,
  },
  {
    id: 'row-key-order',
    severity: 'ERROR',
    summary: 'row keys are in DDL column order',
    run: ruleRowKeyOrder,
  },
  {
    id: 'row-order',
    severity: 'ERROR',
    summary: 'rows are sorted bytewise by primary key',
    run: ruleRowOrder,
  },
  {
    id: 'json-format',
    severity: 'ERROR',
    summary: 'two-space indentation, one trailing newline, no BOM, no CRLF',
    run: ruleJsonFormat,
  },
  {
    id: 'clock-range',
    severity: 'WARN',
    summary: `clock columns fall between ${CLOCK_MIN_HZ} Hz and ${CLOCK_MAX_HZ} Hz`,
    run: ruleClockRange,
  },
  {
    id: 'year-range',
    severity: 'WARN',
    summary: `year_introduced falls between ${YEAR_MIN} and ${YEAR_MAX}`,
    run: ruleYearRange,
  },
];

/** Runs every lint rule over one file. */
export function lintFile(file: SourceFile, schema: Schema): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const rule of LINT_RULES) out.push(...rule.run(file, schema));
  return out;
}

// ---------------------------------------------------------------------------
// quality warnings (docs/data-quality.md §4) — translation, not re-implementation
// ---------------------------------------------------------------------------

interface WarningTarget {
  readonly table: string;
  readonly column: string;
  readonly fix: string;
}

/**
 * `v_quality_warning` is the normative source of every WARN code; this map only says
 * which table and column each code accuses, so the diagnostic can name a file. Adding a
 * code to the view without adding it here still reports — it just cannot name a file,
 * which is a strictly better failure mode than silently dropping it.
 */
const WARNING_TARGETS: ReadonlyMap<string, WarningTarget> = new Map([
  [
    'CHIP_MANUFACTURER_FAMILY_MISMATCH',
    {
      table: 'chip',
      column: 'manufacturer_id',
      fix: 'confirm the part really is second-sourced; if it is, say so in chip.notes and leave it, otherwise correct manufacturer_id or family_id',
    },
  ],
  [
    'CHIP_NAME_COLLISION',
    {
      table: 'chip',
      column: 'display_name',
      fix: 'rename one of the two, or delete the chip_name row: a string must resolve to one chip, and this one resolves to two',
    },
  ],
  [
    'SYSTEM_NAME_COLLISION',
    {
      table: 'system',
      column: 'name',
      fix: 'rename one of the two, or delete the system_name row: a string must resolve to one system, and this one resolves to two',
    },
  ],
  [
    'MAPPED_INSTANCE_SHARE_LOW',
    {
      table: '',
      column: '',
      fix: 'map more MAME devices in data/mame_device.json — the top candidates are in v_mame_device_worklist',
    },
  ],
  [
    'UNMAPPED_DEVICE_HIGH_IMPACT',
    {
      table: 'mame_device',
      column: 'chip_id',
      fix: 'add a mame_device row in data/mame_device.json mapping this device to a chip_id, or give it an ignore_reason',
    },
  ],
  [
    'CHIP_MISSING_METADATA',
    {
      table: 'chip',
      column: 'manufacturer_id, description',
      fix: 'set manufacturer_id and description on this chip row; omit neither unless it is genuinely unknown',
    },
  ],
  [
    'IMPL_UNVERIFIED_LICENSE',
    {
      table: 'implementation',
      column: 'license_id',
      fix: "read the repository's LICENSE file and set license_id to the matching data/lookup/license.json key",
    },
  ],
  [
    'IMPL_UNVERIFIED_ACCURACY',
    {
      table: 'implementation',
      column: 'accuracy_id',
      fix: 'set accuracy_id to an accuracy_level key once the implementation has been assessed',
    },
  ],
  [
    'IMPL_STALE_REVIEW',
    {
      table: 'implementation',
      column: 'last_reviewed',
      fix: 're-check the upstream repository and set last_reviewed to today, or leave it and accept the warning',
    },
  ],
  [
    'IMPL_UNTARGETED',
    {
      table: 'implementation',
      column: '',
      fix: 'add an implementation_chip or implementation_system row so this implementation targets something',
    },
  ],
  [
    'IMPL_MACHINES_WITHOUT_SYSTEM',
    {
      table: 'implementation',
      column: '',
      fix: 'add the implementation_system row this core belongs to, or drop the implementation_machine rows',
    },
  ],
  [
    'SYSTEM_NO_CHIPS',
    {
      table: 'system',
      column: '',
      fix: 'add system_chip rows for the documented parts on this board, or a system_driver row so machines supply them',
    },
  ],
  [
    'SYSTEM_UNMAPPED_SHARE_HIGH',
    {
      table: 'system',
      column: '',
      fix: "map this system's unmapped MAME devices in data/mame_device.json before quoting its coverage",
    },
  ],
  [
    'MACHINE_ZERO_MAPPED_CHIPS',
    {
      table: 'machine',
      column: '',
      fix: 'map the devices this machine uses, or link its driver to a system with a curated BOM',
    },
  ],
  [
    'EQUIVALENCE_MUTUAL_PROVIDES',
    {
      table: 'chip_equivalence',
      column: 'kind',
      fix: "replace the two 'provides' rows with one 'equivalent' row in data/chip_equivalence.json",
    },
  ],
]);

/** One row of `v_quality_warning`. */
export interface QualityWarningRow {
  readonly code: string;
  readonly subject: string | null;
  readonly impact: number | null;
  readonly detail: string;
}

/**
 * Turns a `v_quality_warning` row into a diagnostic. `locate` maps (table, key) back to
 * the file the row was read from — the one piece of information a view cannot hold.
 */
export function qualityWarningDiagnostic(
  row: QualityWarningRow,
  locate: (table: string, key: string) => string | undefined,
): Diagnostic {
  const target = WARNING_TARGETS.get(row.code);
  const table = target?.table ?? '';
  const key = row.subject ?? '';
  const impact = row.impact === null ? '' : ` (impact ${row.impact})`;
  return {
    severity: 'WARN',
    file: (table === '' ? undefined : locate(table, key)) ?? '(database)',
    table,
    key,
    column: target?.column ?? '',
    rule: row.code.toLowerCase().replaceAll('_', '-'),
    message: `${row.detail}${impact}`,
    fix: target?.fix ?? 'see docs/data-quality.md §4 for this code',
  };
}

/** The WARN codes this validator can report, for the rule listing. */
export const QUALITY_WARNING_CODES: readonly string[] = [...WARNING_TARGETS.keys()].sort();
