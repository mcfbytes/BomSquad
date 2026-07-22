/**
 * Row files: discovery, parsing, and the mechanical check that the JSON Schemas in
 * `schemas/` still agree with the DDL column-for-column.
 *
 * A row file is a *table fragment bundle* (data-model.md §4.1): a JSON object whose
 * top-level keys are table names and whose values are arrays of flat rows. There is no
 * nesting, no positional encoding and no key that is a field name, so the reader is
 * "for each file, for each key, insert into that table" and nothing else.
 *
 * Discovery is a recursive walk for `*.json`, not a hard-coded directory list. The
 * layout in §4.2 is then a curation convention rather than a thing the loader can
 * disagree with, and renaming a directory costs no code.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describeTables, listTables, tableSql } from './introspect.js';
import type { DatabaseSync } from 'node:sqlite';

/** A cell. `NULL` columns are omitted from the file, never written as `null` (§4.3). */
export type RowValue = string | number;
export type Row = Readonly<Record<string, RowValue>>;

export interface RowFile {
  /** Absolute path, for error messages. */
  readonly path: string;
  /** Table name → rows, in file order. */
  readonly tables: ReadonlyMap<string, readonly Row[]>;
}

/**
 * Tables with no row file. `threshold` is written by the loader from
 * `pipeline/config/quality-thresholds.json` (see `db/thresholds.ts`), so it has no
 * curated or generated row file and needs no row schema.
 */
export const TABLES_WITHOUT_ROW_FILES: readonly string[] = ['threshold'];

/** JSON Schema documents in `schemas/` that describe something other than a table row. */
const NON_ROW_SCHEMAS: readonly string[] = [
  'common.schema.json',
  'rowfile.schema.json',
  'quality-report.schema.json',
];

const SCHEMA_ID_PREFIX = 'https://bomsquad.dev/schemas/';

/** Bytewise UTF-8 comparison. Locale collation and UTF-16 order are both wrong here (§4.3). */
export function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every `*.json` under `roots`, recursively, sorted bytewise so a build is reproducible. */
export function discoverRowFiles(roots: readonly string[]): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // a root that does not exist yet is empty, not an error
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith('.json')) found.push(path);
    }
  };
  for (const root of roots) walk(root);
  return found.sort(compareBytes);
}

/** Parses and shape-checks one bundle. Every rejection names the file, table, row and key. */
export function readRowFile(path: string): RowFile {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isPlainObject(raw)) {
    throw new Error(`${path}: a row file must be a JSON object keyed by table name`);
  }
  const tables = new Map<string, readonly Row[]>();
  for (const [table, value] of Object.entries(raw)) {
    if (!Array.isArray(value)) {
      throw new Error(`${path}: '${table}' must be an array of rows`);
    }
    const rows: Row[] = [];
    value.forEach((candidate: unknown, index) => {
      if (!isPlainObject(candidate)) {
        throw new Error(`${path}: ${table}[${index}] must be an object`);
      }
      const row: Record<string, RowValue> = {};
      for (const [key, cell] of Object.entries(candidate)) {
        if (cell === null) {
          throw new Error(
            `${path}: ${table}[${index}].${key} is null; omit unknown columns instead (§4.3)`,
          );
        }
        if (typeof cell === 'string' || typeof cell === 'number') {
          row[key] = cell;
          continue;
        }
        throw new Error(
          `${path}: ${table}[${index}].${key} is ${Array.isArray(cell) ? 'an array' : typeof cell}; ` +
            'rows are flat and every cell is a string or a number (§4.1)',
        );
      }
      rows.push(row);
    });
    tables.set(table, rows);
  }
  return { path, tables };
}

// ---------------------------------------------------------------------------
// DDL ↔ JSON Schema drift
// ---------------------------------------------------------------------------

export interface SchemaDrift {
  /** Table, or the schema file name when the drift is not about a table. */
  readonly subject: string;
  readonly detail: string;
}

/** A property's effective keywords after `$ref` into `common.schema.json`. */
export interface ResolvedProperty {
  readonly type: string | undefined;
  readonly pattern: string | undefined;
  /** An `enum` constrains the value more tightly than any pattern could. */
  readonly enumerated: boolean;
}

interface RowSchemaDocument {
  readonly id: string | undefined;
  readonly title: string | undefined;
  readonly type: unknown;
  readonly additionalProperties: unknown;
  readonly required: readonly string[];
  readonly propertyNames: readonly string[];
  readonly properties: ReadonlyMap<string, ResolvedProperty>;
}

/** The `$defs` of `schemas/common.schema.json`, which every row schema `$ref`s into. */
function readCommonDefs(schemasDir: string): Map<string, Record<string, unknown>> {
  const raw: unknown = JSON.parse(readFileSync(join(schemasDir, 'common.schema.json'), 'utf8'));
  const defs = isPlainObject(raw) ? raw['$defs'] : undefined;
  const out = new Map<string, Record<string, unknown>>();
  if (isPlainObject(defs)) {
    for (const [name, value] of Object.entries(defs)) {
      if (isPlainObject(value)) out.set(name, value);
    }
  }
  return out;
}

const COMMON_REF = /^common\.schema\.json#\/\$defs\/(.+)$/;

/**
 * A property's effective keywords. Almost every one is `{ "$ref": "common…/slug" }` plus
 * a `description`, so the row schema on its own says nothing about type or grammar — the
 * reason drift in either used to be invisible to this comparison.
 */
function resolveProperty(
  property: unknown,
  defs: ReadonlyMap<string, Record<string, unknown>>,
): ResolvedProperty {
  if (!isPlainObject(property)) return { type: undefined, pattern: undefined, enumerated: false };
  const ref = property['$ref'];
  const target = typeof ref === 'string' ? COMMON_REF.exec(ref) : null;
  const base = target === null ? {} : (defs.get(target[1] ?? '') ?? {});
  const merged = { ...base, ...property };
  const type = merged['type'];
  const pattern = merged['pattern'];
  return {
    type: typeof type === 'string' ? type : undefined,
    pattern: typeof pattern === 'string' ? pattern : undefined,
    enumerated: Array.isArray(merged['enum']),
  };
}

function readJsonSchema(
  path: string,
  defs: ReadonlyMap<string, Record<string, unknown>> = new Map(),
): RowSchemaDocument {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isPlainObject(raw)) throw new Error(`${path}: not a JSON object`);
  const id = raw['$id'];
  const title = raw['title'];
  const required = raw['required'];
  const properties = raw['properties'];
  const resolved = new Map<string, ResolvedProperty>();
  if (isPlainObject(properties)) {
    for (const [name, value] of Object.entries(properties)) {
      resolved.set(name, resolveProperty(value, defs));
    }
  }
  return {
    id: typeof id === 'string' ? id : undefined,
    title: typeof title === 'string' ? title : undefined,
    type: raw['type'],
    additionalProperties: raw['additionalProperties'],
    required: Array.isArray(required)
      ? required.filter((x): x is string => typeof x === 'string')
      : [],
    propertyNames: isPlainObject(properties) ? Object.keys(properties) : [],
    properties: resolved,
  };
}

// ---------------------------------------------------------------------------
// CHECK constraints, read out of the DDL
// ---------------------------------------------------------------------------

/** The JSON Schema `type` a SQLite declared type must map to. */
const JSON_TYPE_OF: ReadonlyMap<string, string> = new Map([
  ['TEXT', 'string'],
  ['INTEGER', 'integer'],
  ['REAL', 'number'],
]);

/** Every `CHECK (…)` expression in one `CREATE TABLE` statement, parens balanced. */
function checkExpressions(sql: string): string[] {
  const out: string[] = [];
  for (const match of sql.matchAll(/\bCHECK\s*\(/gi)) {
    const start = match.index + match[0].length;
    let index = start;
    let depth = 1;
    while (index < sql.length && depth > 0) {
      const character = sql[index];
      if (character === "'") {
        const close = sql.indexOf("'", index + 1);
        if (close < 0) break;
        index = close;
      } else if (character === '(') depth += 1;
      else if (character === ')') depth -= 1;
      index += 1;
    }
    out.push(sql.slice(start, index - 1));
  }
  return out;
}

/**
 * Each column's constraint text, with the column's own name replaced by a placeholder
 * and whitespace collapsed. Two columns with the same text are constrained identically
 * by the DDL and MUST therefore carry the same JSON Schema `pattern`; that is what makes
 * `machine_chip.mame_tag` and `machine_chip_correction.mame_tag` provably one grammar
 * rather than two copies of one.
 */
function columnChecks(tableSql: string, columns: readonly string[]): Map<string, string> {
  const expressions = checkExpressions(tableSql).map((text) => text.replace(/\s+/g, ' ').trim());
  const out = new Map<string, string>();
  for (const column of columns) {
    const word = new RegExp(`\\b${column}\\b`, 'g');
    const mentioning = expressions.filter((text) => new RegExp(`\\b${column}\\b`).test(text));
    out.set(column, mentioning.map((text) => text.replace(word, '«col»')).join(' & '));
  }
  return out;
}

/** A CHECK that constrains the *shape* of a string, so the row schema owes a `pattern`. */
function constrainsShape(check: string): boolean {
  return /\bGLOB\b/i.test(check) || /\btrim\s*\(/i.test(check);
}

/**
 * Compares every `schemas/<table>.schema.json` against the live DDL and reports each
 * disagreement. This is the mechanical guarantee that the two never drift:
 *
 * - property names and their order equal the table's columns in declaration order;
 * - `required` equals exactly the `NOT NULL` columns that have no `DEFAULT` (a column
 *   with a default may be omitted from a row file; a nullable one is omitted rather than
 *   written as `null`);
 * - every property's **type**, resolved through its `$ref` into `common.schema.json`,
 *   equals the column's declared SQLite type;
 * - every column whose `CHECK` constrains a string's shape has a **pattern**, and columns
 *   the DDL constrains identically declare the *same* pattern.
 *
 * The last two are what a name-and-order comparison missed: a property could keep its
 * name, change its grammar, and pass. Whether a pattern is *equal to* the `CHECK` it
 * mirrors is not decidable from the text of either, so that is proved separately, by
 * brute force over a corpus, in `pipeline/test/schema.test.ts`.
 */
export function diffRowSchemas(db: DatabaseSync, schemasDir: string): SchemaDrift[] {
  const drift: SchemaDrift[] = [];
  const skip = new Set(TABLES_WITHOUT_ROW_FILES);
  const expected = listTables(db).filter((table) => !skip.has(table));
  const expectedSet = new Set(expected);
  const defs = readCommonDefs(schemasDir);
  /** Normalised CHECK text → the patterns row schemas give the columns carrying it. */
  const grammars = new Map<string, Map<string, string>>();

  const files = readdirSync(schemasDir)
    .filter((name) => name.endsWith('.schema.json') && !NON_ROW_SCHEMAS.includes(name))
    .sort(compareBytes);

  for (const file of files) {
    const table = file.slice(0, -'.schema.json'.length);
    if (!expectedSet.has(table)) {
      drift.push({ subject: file, detail: `no table named '${table}' in the DDL` });
    }
  }
  const present = new Set(files.map((file) => file.slice(0, -'.schema.json'.length)));

  for (const info of describeTables(db)) {
    if (skip.has(info.name)) continue;
    if (!present.has(info.name)) {
      drift.push({ subject: info.name, detail: `no schemas/${info.name}.schema.json` });
      continue;
    }
    const doc = readJsonSchema(join(schemasDir, `${info.name}.schema.json`), defs);
    const columns = info.columns.map((column) => column.name);
    const required = info.columns
      .filter((column) => column.notNull && !column.hasDefault)
      .map((column) => column.name);
    const checks = columnChecks(tableSql(db, info.name), columns);

    for (const column of info.columns) {
      const property = doc.properties.get(column.name);
      if (property === undefined) continue; // reported as a missing property below
      const wanted = JSON_TYPE_OF.get(column.declaredType);
      if (property.type !== wanted) {
        drift.push({
          subject: info.name,
          detail: `${column.name} is ${column.declaredType} in the DDL but type '${String(property.type)}' in the schema`,
        });
      }
      const check = checks.get(column.name) ?? '';
      if (property.pattern === undefined && !property.enumerated && constrainsShape(check)) {
        drift.push({
          subject: info.name,
          detail: `${column.name} has a shape CHECK but no pattern`,
        });
      }
      if (check !== '' && property.pattern !== undefined) {
        const bucket = grammars.get(check) ?? new Map<string, string>();
        bucket.set(`${info.name}.${column.name}`, property.pattern);
        grammars.set(check, bucket);
      }
    }

    if (doc.id !== `${SCHEMA_ID_PREFIX}${info.name}.schema.json`) {
      drift.push({ subject: info.name, detail: `$id is ${String(doc.id)}` });
    }
    if (doc.title !== info.name) {
      drift.push({ subject: info.name, detail: `title is ${String(doc.title)}` });
    }
    if (doc.type !== 'object') {
      drift.push({ subject: info.name, detail: `type is ${String(doc.type)}, expected 'object'` });
    }
    if (doc.additionalProperties !== false) {
      drift.push({ subject: info.name, detail: 'additionalProperties is not false' });
    }
    let sameSet = true;
    for (const column of columns) {
      if (!doc.propertyNames.includes(column)) {
        drift.push({ subject: info.name, detail: `column '${column}' has no property` });
        sameSet = false;
      }
    }
    for (const property of doc.propertyNames) {
      if (!columns.includes(property)) {
        drift.push({ subject: info.name, detail: `property '${property}' has no column` });
        sameSet = false;
      }
    }
    if (sameSet && doc.propertyNames.join(',') !== columns.join(',')) {
      drift.push({ subject: info.name, detail: 'property order differs from DDL column order' });
    }
    if (doc.required.join(',') !== required.join(',')) {
      drift.push({
        subject: info.name,
        detail: `required is [${doc.required.join(', ')}], expected [${required.join(', ')}]`,
      });
    }
  }

  // Columns the DDL constrains identically must be given identical patterns.
  for (const [, carriers] of [...grammars].sort((a, b) => compareBytes(a[0], b[0]))) {
    const byPattern = new Map<string, string[]>();
    for (const [column, pattern] of [...carriers].sort((a, b) => compareBytes(a[0], b[0]))) {
      byPattern.set(pattern, [...(byPattern.get(pattern) ?? []), column]);
    }
    if (byPattern.size <= 1) continue;
    const shown = [...byPattern]
      .sort((a, b) => compareBytes(a[0], b[0]))
      .map(([pattern, columns]) => `${columns[0] ?? '?'} (+${columns.length - 1}) => ${pattern}`)
      .join('; ');
    drift.push({
      subject: 'common.schema.json',
      detail: `columns with one DDL CHECK carry ${byPattern.size} patterns: ${shown}`,
    });
  }

  // The envelope must offer exactly the tables that have row schemas.
  const envelope = readJsonSchema(join(schemasDir, 'rowfile.schema.json'));
  for (const table of expected) {
    if (!envelope.propertyNames.includes(table)) {
      drift.push({ subject: 'rowfile.schema.json', detail: `no property for table '${table}'` });
    }
  }
  for (const property of envelope.propertyNames) {
    if (!expectedSet.has(property)) {
      drift.push({
        subject: 'rowfile.schema.json',
        detail: `property '${property}' is not a row-file table`,
      });
    }
  }
  return drift;
}
