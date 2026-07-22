/**
 * Loads curated (`data/`) and generated (`extract/`) row files into a database.
 *
 * Three properties, each load-bearing:
 *
 * 1. **FK-safe order, computed.** Tables are inserted in the topological order of the
 *    foreign-key graph read out of the database itself (`tableLoadOrder`), so adding a
 *    foreign key reorders the load with no edit here.
 * 2. **One transaction.** Either the whole dataset lands or none of it does; a half-loaded
 *    database can never be published.
 * 3. **Deterministic.** Rows are sorted by primary key, bytewise, before insert; identical
 *    inputs therefore produce an identical page layout and a byte-identical file after
 *    `VACUUM` (data-model.md §4.3).
 *
 * Foreign keys are OFF for the duration of the transaction, per data-model.md §0.1, so
 * rows may be inserted in any table order and a row may legitimately reference one that
 * sorts after it. `PRAGMA foreign_key_check` afterwards is the enforcement, and it
 * reports every dangling reference in the whole database in one call.
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';

import { describeTables, tableLoadOrder, type TableInfo } from './introspect.js';
import {
  compareBytes,
  discoverRowFiles,
  readRowFile,
  type Row,
  type RowFile,
  type RowValue,
} from './rowfiles.js';

export interface LoadResult {
  /** Files read, in the order they were read. */
  readonly files: readonly string[];
  /** Table → rows inserted. Tables with no rows are absent. */
  readonly rowCounts: ReadonlyMap<string, number>;
  /** Total rows inserted. */
  readonly total: number;
}

/** Collects rows for one table from every file, preserving discovery order. */
function collect(files: readonly RowFile[], known: ReadonlySet<string>): Map<string, Row[]> {
  const byTable = new Map<string, Row[]>();
  for (const file of files) {
    for (const [table, rows] of file.tables) {
      if (!known.has(table)) {
        throw new Error(`${file.path}: '${table}' is not a table in this schema`);
      }
      const bucket = byTable.get(table) ?? [];
      bucket.push(...rows);
      byTable.set(table, bucket);
    }
  }
  return byTable;
}

/** Bytewise for text, numeric for integers — never locale collation, never `"10" < "9"`. */
function compareCells(a: RowValue | undefined, b: RowValue | undefined): number {
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  return compareBytes(String(a ?? ''), String(b ?? ''));
}

/** Comparison on the primary-key columns, in declaration order. */
function byPrimaryKey(primaryKey: readonly string[]): (a: Row, b: Row) => number {
  return (a, b) => {
    for (const column of primaryKey) {
      const order = compareCells(a[column], b[column]);
      if (order !== 0) return order;
    }
    return 0;
  };
}

/**
 * Builds the INSERT for one distinct set of present columns. Rows omit their `NULL`
 * columns, so a single all-columns statement is wrong: binding `NULL` into a column
 * that has a `DEFAULT` (`quantity`, `is_top`) would defeat the default and fail the
 * `NOT NULL`. One statement per column signature is the boring correct answer, and
 * there are only a handful of signatures per table.
 */
function insertSql(table: string, columns: readonly string[]): string {
  const names = columns.map((column) => `"${column}"`).join(', ');
  const params = columns.map((column) => `:${column}`).join(', ');
  return `INSERT INTO "${table}" (${names}) VALUES (${params})`;
}

function insertTable(db: DatabaseSync, info: TableInfo, rows: readonly Row[]): number {
  const columnOrder = info.columns.map((column) => column.name);
  const known = new Set(columnOrder);
  const statements = new Map<string, StatementSync>();

  const sorted = [...rows].sort(byPrimaryKey(info.primaryKey));
  for (const row of sorted) {
    for (const key of Object.keys(row)) {
      if (!known.has(key)) {
        throw new Error(`${info.name}: no column '${key}' (row ${JSON.stringify(row)})`);
      }
    }
    const present = columnOrder.filter((column) => column in row);
    if (present.length === 0) {
      throw new Error(`${info.name}: empty row`);
    }
    const signature = present.join(',');
    let statement = statements.get(signature);
    if (statement === undefined) {
      statement = db.prepare(insertSql(info.name, present));
      statements.set(signature, statement);
    }
    const bound: Record<string, string | number> = {};
    for (const column of present) {
      const value = row[column];
      if (value !== undefined) bound[column] = value;
    }
    statement.run(bound);
  }
  return sorted.length;
}

/**
 * Inserts already-parsed row files. Exposed separately from {@link loadDataset} so tests
 * and the build can drive it from an in-memory fixture without touching the filesystem.
 */
export function loadRowFiles(db: DatabaseSync, files: readonly RowFile[]): LoadResult {
  const infos = new Map(describeTables(db).map((info) => [info.name, info]));
  const order = tableLoadOrder(db);
  const byTable = collect(files, new Set(infos.keys()));
  const rowCounts = new Map<string, number>();

  const foreignKeysWereOn = readForeignKeysPragma(db);
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    for (const table of order) {
      const rows = byTable.get(table);
      if (rows === undefined || rows.length === 0) continue;
      const info = infos.get(table);
      if (info === undefined) throw new Error(`no such table: ${table}`);
      rowCounts.set(table, insertTable(db, info, rows));
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    if (foreignKeysWereOn) db.exec('PRAGMA foreign_keys = ON');
  }

  let total = 0;
  for (const count of rowCounts.values()) total += count;
  return { files: files.map((file) => file.path), rowCounts, total };
}

/** Discovers, parses and loads every row file under `roots` (normally `data/` and `extract/`). */
export function loadDataset(db: DatabaseSync, roots: readonly string[]): LoadResult {
  return loadRowFiles(db, discoverRowFiles(roots).map(readRowFile));
}

function readForeignKeysPragma(db: DatabaseSync): boolean {
  return db.prepare('PRAGMA foreign_keys').get()?.['foreign_keys'] === 1;
}
