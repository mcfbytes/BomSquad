/**
 * `pipeline validate` — three cheap layers instead of one expensive hand-written one.
 *
 * 1. **Shape.** Each row file is validated against `schemas/rowfile.schema.json` with ajv.
 *    That covers JSON structure, column spelling, types, string grammars and required
 *    columns. The row schemas are hand-curated (schemas/README.md), not generated, so
 *    they *can* drift; what stops them is `diffRowSchemas()`, which compares every schema
 *    against the live DDL — property names, their order, `required`, each property's
 *    resolved type, and the grammar patterns — and fails the test suite on any
 *    disagreement. Equality of a `pattern` with the `CHECK` it mirrors is proved
 *    separately, by brute force over a corpus, in `pipeline/test/schema.test.ts`.
 * 2. **Referential and constraint integrity.** The row files are loaded into a fresh
 *    in-memory database built from `schemas/schema.sql`, and the DDL does the work:
 *    `PRIMARY KEY`, `UNIQUE`, `CHECK` and `NOT NULL` surface as insert failures, and
 *    `PRAGMA foreign_key_check` plus `PRAGMA integrity_check` finish the job. **No check
 *    in this file duplicates a constraint.** The only hand-written SQL is the locator in
 *    {@link attributeForeignKeyFailures}, which does not decide anything — the pragma has
 *    already decided — it only works out *which row* so the diagnostic can name it.
 * 3. **Lint.** The handful of rules a database cannot express, in `rules.ts`, plus the
 *    WARN codes of docs/data-quality.md §4, which are read from the shipped view
 *    `v_quality_warning` rather than re-implemented.
 *
 * An empty `data/` tree is a valid dataset: zero files, zero rows, no diagnostics, exit 0.
 * Discovery only ever matches `*.json`, so `README.md` and `.gitkeep` are invisible to it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

import { describeTables, tableLoadOrder, type TableInfo } from '../db/introspect.js';
import { applySchema, SCHEMAS_DIR } from '../db/schema.js';
import { loadThresholds } from '../db/thresholds.js';
import {
  compareBytes,
  discoverRowFiles,
  readRowFile,
  type Row,
  type RowValue,
} from '../db/rowfiles.js';
import {
  lintFile,
  qualityWarningDiagnostic,
  rowKey,
  type Diagnostic,
  type QualityWarningRow,
  type Schema,
  type SourceFile,
} from './rules.js';
import type { ValidationResult } from './report.js';

/**
 * `ajv-formats` declares an ES default export but assigns `module.exports`, so under
 * `verbatimModuleSyntax` + NodeNext the imported binding is the plugin itself while the
 * type says `{ default: plugin }`. One cast, documented, at the boundary.
 */
const addFormats = addFormatsModule as unknown as (typeof addFormatsModule)['default'];

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

export interface ValidateOptions {
  /** Directories to scan. Defaults to `data/` and `extract/` at the repository root. */
  readonly roots?: readonly string[];
  /** Path diagnostics are reported relative to. Defaults to the repository root. */
  readonly baseDir?: string;
  /**
   * `build_date` for `IMPL_STALE_REVIEW`. Defaults to the dataset's own `build_date` row,
   * then to today (UTC). The validation database is never published, so a wall-clock
   * default here cannot make a *build* non-deterministic.
   */
  readonly buildDate?: string;
  /** Thresholds for the WARN views. Defaults to `config/quality-thresholds.json`. */
  readonly thresholds?: Readonly<Record<string, unknown>>;
}

/** Repository-relative, forward-slashed, for stable diagnostics on any platform. */
function toRelative(baseDir: string, path: string): string {
  return relative(baseDir, path).split(sep).join('/');
}

// ---------------------------------------------------------------------------
// Layer 1 — shape
// ---------------------------------------------------------------------------

interface SchemaValidator {
  (data: unknown): boolean;
  errors?: readonly AjvError[] | null;
}

interface AjvError {
  readonly instancePath: string;
  readonly schemaPath: string;
  readonly keyword: string;
  readonly message?: string | undefined;
  readonly params: Readonly<Record<string, unknown>>;
}

/** Compiles `rowfile.schema.json` with every row schema registered under its `$id`. */
export function createRowFileValidator(schemasDir = SCHEMAS_DIR): SchemaValidator {
  const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
  addFormats(ajv);
  const files = readdirSync(schemasDir).sort(compareBytes);
  for (const name of files) {
    if (!name.endsWith('.schema.json')) continue;
    if (name === 'quality-report.schema.json') continue;
    const document = JSON.parse(readFileSync(join(schemasDir, name), 'utf8')) as Record<
      string,
      unknown
    >;
    ajv.addSchema(document);
  }
  return ajv.getSchema('https://bomsquad.dev/schemas/rowfile.schema.json') as SchemaValidator;
}

/** Safe stringification of an ajv `params` value, which is typed `unknown`. */
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function ajvFix(error: AjvError, table: string, column: string): string {
  switch (error.keyword) {
    case 'required':
      return `add the required column '${text(error.params['missingProperty'])}' to this ${table} row`;
    case 'additionalProperties':
      return `remove '${text(error.params['additionalProperty'])}' — it is not a column of ${table}; check schemas/${table}.schema.json`;
    case 'minProperties':
      return 'a row file must declare at least one table; delete the file or add rows';
    case 'pattern':
      return `rewrite ${column} to match ${text(error.params['pattern'])} (grammars are docs/data-model.md §3.2)`;
    case 'type':
      return `write ${column} as ${text(error.params['type'])}, unquoted for numbers`;
    case 'enum':
      return `set ${column} to one of ${text(error.params['allowedValues'])}`;
    case 'minimum':
    case 'maximum':
      return `set ${column} within the schema's range (${error.keyword} ${text(error.params['limit'])})`;
    case 'minLength':
    case 'maxLength':
      return `adjust the length of ${column} (${error.keyword} ${text(error.params['limit'])})`;
    case 'format':
      return `write ${column} as a valid ${text(error.params['format'])}`;
    default:
      return `correct ${column === '' ? 'this row' : column} against schemas/${table === '' ? 'rowfile' : table}.schema.json`;
  }
}

/** Turns ajv's `instancePath` back into (table, row index, column). */
function locateAjvError(error: AjvError): { table: string; index: number; column: string } {
  const parts = error.instancePath.split('/').filter((part) => part !== '');
  const table = parts[0] ?? '';
  const index = Number.parseInt(parts[1] ?? '', 10);
  let column = parts[2] ?? '';
  if (column === '') {
    if (error.keyword === 'required') column = text(error.params['missingProperty']);
    else if (error.keyword === 'additionalProperties')
      column = text(error.params['additionalProperty']);
  }
  return { table, index: Number.isNaN(index) ? -1 : index, column };
}

export function validateShape(
  file: SourceFile,
  raw: unknown,
  validator: SchemaValidator,
  schema: Schema,
): Diagnostic[] {
  if (validator(raw)) return [];
  const out: Diagnostic[] = [];
  const seen = new Set<string>();
  for (const error of validator.errors ?? []) {
    // `anyOf`/`oneOf` wrappers add noise without adding information.
    if (error.keyword === 'if' || error.keyword === 'anyOf' || error.keyword === 'oneOf') continue;
    // A top-level key that is not a table is reported by `unknown-table`, which names the
    // table set; saying it twice adds noise, not information.
    if (error.instancePath === '' && error.keyword === 'additionalProperties') continue;
    const { table, index, column } = locateAjvError(error);
    const rows = file.tables.get(table);
    const row = index >= 0 ? rows?.[index] : undefined;
    const key =
      row === undefined ? String(index >= 0 ? index : '') : rowKey(schema.get(table), row);
    const signature = `${table} ${key} ${column} ${error.keyword}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    out.push({
      severity: 'ERROR',
      file: file.relativePath,
      table,
      key,
      column,
      rule: 'schema-shape',
      message: `${error.message ?? 'is invalid'} (${error.keyword})`,
      fix: ajvFix(error, table, column),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Layer 2 — the database
// ---------------------------------------------------------------------------

/** A row together with the file it came from, which is the only thing SQL cannot know. */
interface PlacedRow {
  readonly file: string;
  readonly table: string;
  readonly row: Row;
}

function compareCells(a: RowValue | undefined, b: RowValue | undefined): number {
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  return compareBytes(String(a ?? ''), String(b ?? ''));
}

function byPrimaryKey(info: TableInfo): (a: PlacedRow, b: PlacedRow) => number {
  return (a, b) => {
    for (const column of info.primaryKey) {
      const order = compareCells(a.row[column], b.row[column]);
      if (order !== 0) return order;
    }
    return 0;
  };
}

/**
 * SQLite's own error text, turned into a diagnostic that names the row and column.
 *
 * The messages are stable and documented: `UNIQUE constraint failed: <table>.<col>[, …]`,
 * `NOT NULL constraint failed: <table>.<col>`, `CHECK constraint failed: <name-or-expr>`,
 * and for expression indexes `UNIQUE constraint failed: index '<name>'`.
 */
export function translateSqliteError(
  message: string,
  placed: PlacedRow,
  info: TableInfo,
): Diagnostic {
  const key = rowKey(info, placed.row);
  const base = {
    severity: 'ERROR' as const,
    file: placed.file,
    table: placed.table,
    key,
  };

  const unique = /^UNIQUE constraint failed: (.+)$/.exec(message);
  if (unique !== null) {
    const target = unique[1] ?? '';
    const indexed = /^index '(.+)'$/.exec(target);
    if (indexed !== null) {
      return {
        ...base,
        column: '',
        rule: 'unique-violation',
        message: `duplicates an existing row under unique index '${indexed[1] ?? ''}'`,
        fix: `remove or amend this row; '${indexed[1] ?? ''}' already holds an equivalent one (see schemas/schema.sql)`,
      };
    }
    const columns = target
      .split(',')
      .map((part) => part.trim().split('.').slice(1).join('.'))
      .filter((part) => part !== '');
    const isPrimaryKey =
      columns.length === info.primaryKey.length &&
      columns.every((column) => info.primaryKey.includes(column));
    const shown = columns.join(', ');
    const values = columns.map((column) => `${column}='${String(placed.row[column] ?? '')}'`);
    return {
      ...base,
      column: shown,
      rule: isPrimaryKey ? 'primary-key-violation' : 'unique-violation',
      message: isPrimaryKey
        ? `duplicate primary key (${values.join(', ')})`
        : `duplicate value for UNIQUE (${values.join(', ')})`,
      fix: isPrimaryKey
        ? `another row already declares ${shown} '${key}'; delete this one or give it a distinct key`
        : `${shown} must be unique across ${placed.table}; change it or delete the duplicate row`,
    };
  }

  const notNull = /^NOT NULL constraint failed: [^.]+\.(.+)$/.exec(message);
  if (notNull !== null) {
    const column = notNull[1] ?? '';
    return {
      ...base,
      column,
      rule: 'not-null-violation',
      message: `${column} is required but missing`,
      fix: `add "${column}" to this row — it is NOT NULL in schemas/schema.sql`,
    };
  }

  const check = /^CHECK constraint failed: (.+)$/.exec(message);
  if (check !== null) {
    const expression = check[1] ?? '';
    const column =
      info.columns.find((candidate) => expression.includes(candidate.name))?.name ?? '';
    const value = column === '' ? '' : ` (${column}='${String(placed.row[column] ?? '')}')`;
    return {
      ...base,
      column,
      rule: 'check-violation',
      message: `violates CHECK ${expression}${value}`,
      fix:
        column === ''
          ? `amend this row so it satisfies CHECK ${expression} in schemas/schema.sql`
          : `amend ${column} so it satisfies CHECK ${expression} in schemas/schema.sql`,
    };
  }

  return {
    ...base,
    column: '',
    rule: 'insert-failed',
    message,
    fix: `correct this ${placed.table} row against schemas/schema.sql`,
  };
}

/**
 * Inserts every row, recording each failure instead of aborting on the first.
 *
 * This is deliberately *not* `src/db/load.ts`. That loader is the build's: one
 * transaction, fail fast, all-or-nothing, because a half-loaded database must never be
 * published. A validator wants the opposite — every failure in one run. Both read their
 * insert order from {@link tableLoadOrder}, so neither holds a hand-written table list.
 */
function insertTolerantly(
  db: DatabaseSync,
  placed: readonly PlacedRow[],
  schema: Schema,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const byTable = new Map<string, PlacedRow[]>();
  for (const entry of placed) {
    const bucket = byTable.get(entry.table) ?? [];
    bucket.push(entry);
    byTable.set(entry.table, bucket);
  }

  db.exec('PRAGMA foreign_keys = OFF');
  for (const table of tableLoadOrder(db)) {
    const rows = byTable.get(table);
    const info = schema.get(table);
    if (rows === undefined || info === undefined) continue;
    const columnNames = new Set(info.columns.map((column) => column.name));
    for (const entry of [...rows].sort(byPrimaryKey(info))) {
      const present = info.columns
        .map((column) => column.name)
        .filter((column) => column in entry.row);
      const unknown = Object.keys(entry.row).filter((column) => !columnNames.has(column));
      if (unknown.length > 0) {
        out.push({
          severity: 'ERROR',
          file: entry.file,
          table,
          key: rowKey(info, entry.row),
          column: unknown.join(', '),
          rule: 'unknown-column',
          message: `${table} has no column ${unknown.map((c) => `'${c}'`).join(', ')}`,
          fix: `remove ${unknown.map((c) => `'${c}'`).join(', ')} or correct the spelling; columns are [${[...columnNames].join(', ')}]`,
        });
        continue;
      }
      if (present.length === 0) continue;
      const sql =
        `INSERT INTO "${table}" (${present.map((c) => `"${c}"`).join(', ')}) ` +
        `VALUES (${present.map((c) => `:${c}`).join(', ')})`;
      const bound: Record<string, RowValue> = {};
      for (const column of present) {
        const value = entry.row[column];
        if (value !== undefined) bound[column] = value;
      }
      try {
        db.prepare(sql).run(bound);
      } catch (error) {
        out.push(translateSqliteError(messageOf(error), entry, info));
      }
    }
  }
  return out;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `PRAGMA foreign_key_check` decides *that* the dataset has a dangling reference. It
 * cannot say *which row* on a `WITHOUT ROWID` table (it reports a NULL rowid), and every
 * table in this schema is `WITHOUT ROWID`. So when — and only when — the pragma has
 * already reported a violation, each declared foreign key is probed once to attribute it.
 * The edge list comes from `pragma_foreign_key_list`, never from a maintained copy.
 */
function attributeForeignKeyFailures(
  db: DatabaseSync,
  schema: Schema,
  locate: (table: string, key: string) => string | undefined,
): Diagnostic[] {
  const violations = db.prepare('PRAGMA foreign_key_check').all();
  if (violations.length === 0) return [];

  const out: Diagnostic[] = [];
  for (const info of [...schema.values()].sort((a, b) => compareBytes(a.name, b.name))) {
    const groups = db
      .prepare(`SELECT id, seq, "table", "from", "to" FROM pragma_foreign_key_list(?)`)
      .all(info.name);
    const byId = new Map<number, { parent: string; pairs: { from: string; to: string }[] }>();
    for (const row of groups) {
      const id = Number(row['id']);
      const entry = byId.get(id) ?? { parent: String(row['table']), pairs: [] };
      entry.pairs.push({ from: String(row['from']), to: String(row['to']) });
      byId.set(id, entry);
    }
    for (const [, edge] of [...byId.entries()].sort((a, b) => a[0] - b[0])) {
      const notNull = edge.pairs.map(({ from }) => `c."${from}" IS NOT NULL`).join(' AND ');
      const join = edge.pairs.map(({ from, to }) => `p."${to}" = c."${from}"`).join(' AND ');
      const selected = [...info.primaryKey, ...edge.pairs.map(({ from }) => from)];
      const sql =
        `SELECT ${[...new Set(selected)].map((c) => `c."${c}"`).join(', ')} ` +
        `FROM "${info.name}" c WHERE ${notNull} ` +
        `AND NOT EXISTS (SELECT 1 FROM "${edge.parent}" p WHERE ${join}) ` +
        `ORDER BY ${info.primaryKey.map((c) => `c."${c}"`).join(', ')}`;
      for (const row of db.prepare(sql).all()) {
        const asRow: Record<string, RowValue> = {};
        for (const [column, value] of Object.entries(row)) {
          if (typeof value === 'string' || typeof value === 'number') asRow[column] = value;
        }
        const key = rowKey(info, asRow);
        const columns = edge.pairs.map(({ from }) => from).join(', ');
        const values = edge.pairs
          .map(({ from }) => `${from}='${String(asRow[from] ?? '')}'`)
          .join(', ');
        const parentColumns = edge.pairs.map(({ to }) => to).join(', ');
        out.push({
          severity: 'ERROR',
          file: locate(info.name, key) ?? '(database)',
          table: info.name,
          key,
          column: columns,
          rule: 'foreign-key-violation',
          message: `${values} has no matching ${edge.parent}.${parentColumns} row`,
          fix: `add the missing ${edge.parent} row, or change ${columns} to an existing ${edge.parent}.${parentColumns} value`,
        });
      }
    }
  }

  if (out.length === 0) {
    out.push({
      severity: 'ERROR',
      file: '(database)',
      table: String(violations[0]?.['table'] ?? ''),
      key: '',
      column: '',
      rule: 'foreign-key-violation',
      message: `PRAGMA foreign_key_check reported ${violations.length} violation(s) that could not be attributed to a row`,
      fix: 'run "PRAGMA foreign_key_check" against dist/bomsquad.sqlite to inspect them directly',
    });
  }
  return out;
}

function checkIntegrityPragma(db: DatabaseSync): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const row of db.prepare('PRAGMA integrity_check').all()) {
    const result = String(row['integrity_check']);
    if (result === 'ok') continue;
    out.push({
      severity: 'ERROR',
      file: '(database)',
      table: '',
      key: '',
      column: '',
      rule: 'integrity-check',
      message: result,
      fix: 'the freshly built database is structurally unsound — report this, it is a pipeline bug, not a data error',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Layer 3b — the WARN views
// ---------------------------------------------------------------------------

function readQualityWarnings(
  db: DatabaseSync,
  locate: (table: string, key: string) => string | undefined,
): Diagnostic[] {
  const rows = db
    .prepare(
      'SELECT code, subject, impact, detail FROM v_quality_warning ORDER BY code, subject, detail',
    )
    .all();
  return rows.map((row) => {
    const warning: QualityWarningRow = {
      code: String(row['code']),
      subject:
        row['subject'] === null || row['subject'] === undefined ? null : String(row['subject']),
      impact: typeof row['impact'] === 'number' ? row['impact'] : null,
      detail: String(row['detail']),
    };
    return qualityWarningDiagnostic(warning, locate);
  });
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function readThresholds(): Record<string, unknown> {
  const path = join(REPO_ROOT, 'pipeline', 'config', 'quality-thresholds.json');
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function validate(options: ValidateOptions = {}): ValidationResult {
  const roots = options.roots ?? [join(REPO_ROOT, 'data'), join(REPO_ROOT, 'extract')];
  const baseDir = options.baseDir ?? REPO_ROOT;
  const diagnostics: Diagnostic[] = [];

  const db = new DatabaseSync(':memory:');
  applySchema(db);
  const schema: Schema = new Map(describeTables(db).map((info) => [info.name, info]));

  const paths = discoverRowFiles(roots);
  const sources: SourceFile[] = [];
  const raws = new Map<string, unknown>();
  let rowCount = 0;

  for (const path of paths) {
    const relativePath = toRelative(baseDir, path);
    let text: string;
    let raw: unknown;
    try {
      text = readFileSync(path, 'utf8');
      raw = JSON.parse(text);
    } catch (error) {
      diagnostics.push({
        severity: 'ERROR',
        file: relativePath,
        table: '',
        key: '',
        column: '',
        rule: 'json-parse',
        message: messageOf(error),
        fix: 'fix the JSON syntax; a row file is a strict JSON object keyed by table name',
      });
      continue;
    }
    let parsed;
    try {
      parsed = readRowFile(path);
    } catch (error) {
      diagnostics.push({
        severity: 'ERROR',
        file: relativePath,
        table: '',
        key: '',
        column: '',
        rule: 'row-shape',
        message: messageOf(error).replace(`${path}: `, ''),
        fix: 'rows are flat: every value is a string or a number, and unknown columns are omitted rather than written as null (data-model.md §4.1, §4.3)',
      });
      continue;
    }
    const source: SourceFile = { path, relativePath, text, tables: parsed.tables };
    sources.push(source);
    raws.set(path, raw);
    for (const rows of parsed.tables.values()) rowCount += rows.length;
  }

  // Layer 1 — shape.
  if (sources.length > 0) {
    const validator = createRowFileValidator();
    for (const source of sources) {
      diagnostics.push(...validateShape(source, raws.get(source.path), validator, schema));
    }
  }

  // Layer 3a — lint.
  for (const source of sources) diagnostics.push(...lintFile(source, schema));

  // Layer 2 — the database.
  const placed: PlacedRow[] = [];
  for (const source of sources) {
    for (const [table, rows] of source.tables) {
      if (!schema.has(table)) {
        diagnostics.push({
          severity: 'ERROR',
          file: source.relativePath,
          table,
          key: '',
          column: '',
          rule: 'unknown-table',
          message: `'${table}' is not a table in schemas/schema.sql`,
          fix: `rename this top-level key to a table name; a row file's keys are table names, never field names (data-model.md §4.1)`,
        });
        continue;
      }
      for (const row of rows) placed.push({ file: source.relativePath, table, row });
    }
  }

  const fileOf = new Map<string, string>();
  for (const entry of placed) {
    const info = schema.get(entry.table);
    if (info === undefined) continue;
    fileOf.set(`${entry.table} ${rowKey(info, entry.row)}`, entry.file);
  }
  const locate = (table: string, key: string): string | undefined => fileOf.get(`${table} ${key}`);

  diagnostics.push(...insertTolerantly(db, placed, schema));
  db.exec('PRAGMA foreign_keys = ON');
  diagnostics.push(...attributeForeignKeyFailures(db, schema, locate));
  diagnostics.push(...checkIntegrityPragma(db));

  // Layer 3b — the WARN views. `loadThresholds` throws when the config is missing a
  // threshold the views read: a gate that cannot fire must stop the run, not pass it.
  loadThresholds(db, options.thresholds ?? readThresholds());
  // `OR IGNORE` so a dataset that states its own build_date keeps it.
  db.prepare('INSERT OR IGNORE INTO dataset_meta (key, value) VALUES (?, ?)').run(
    'build_date',
    options.buildDate ?? todayUtc(),
  );
  diagnostics.push(...readQualityWarnings(db, locate));

  db.close();
  return { fileCount: sources.length, rowCount, diagnostics };
}
