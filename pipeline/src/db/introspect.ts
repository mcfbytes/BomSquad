/**
 * Schema introspection.
 *
 * Everything downstream — the loader's insert order, the row-file schema drift
 * check, the schema tests — reads the shape of the database from the database
 * itself rather than from a hand-maintained copy of the DDL. A second copy of the
 * column list is a copy that drifts silently; docs/data-quality.md §2.2 deleted
 * exactly that pattern once already.
 */
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';

export interface ColumnInfo {
  /** Column name. */
  readonly name: string;
  /** Declared type: `TEXT` or `INTEGER` — every column in this schema is one or the other. */
  readonly declaredType: string;
  readonly notNull: boolean;
  readonly hasDefault: boolean;
  /** 1-based position within the primary key, or 0 when the column is not part of it. */
  readonly primaryKeyPosition: number;
}

export interface ForeignKeyInfo {
  readonly column: string;
  readonly parentTable: string;
  readonly parentColumn: string;
  /** `CASCADE`, `RESTRICT`, `SET NULL` or `NO ACTION`. */
  readonly onDelete: string;
}

export interface TableInfo {
  readonly name: string;
  /** In declaration order, which is also the canonical key order of a row file. */
  readonly columns: readonly ColumnInfo[];
  /** In primary-key declaration order, which is the row sort order. */
  readonly primaryKey: readonly string[];
  readonly foreignKeys: readonly ForeignKeyInfo[];
}

export interface IndexInfo {
  readonly name: string;
  readonly table: string;
  readonly unique: boolean;
  readonly partial: boolean;
}

function asString(value: SQLOutputValue | undefined): string {
  if (typeof value !== 'string') {
    throw new TypeError(`expected a TEXT value, received ${typeof value}`);
  }
  return value;
}

function asInteger(value: SQLOutputValue | undefined): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  throw new TypeError(`expected an INTEGER value, received ${typeof value}`);
}

function names(db: DatabaseSync, type: 'table' | 'view'): string[] {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_schema
        WHERE type = ? AND name NOT LIKE 'sqlite_%'
        ORDER BY name`,
    )
    .all(type);
  return rows.map((row) => asString(row['name']));
}

/** Every user table, bytewise ascending. */
export function listTables(db: DatabaseSync): string[] {
  return names(db, 'table');
}

/** Every view, bytewise ascending. */
export function listViews(db: DatabaseSync): string[] {
  return names(db, 'view');
}

/** Every explicitly declared index, bytewise ascending. Implicit PK indexes are excluded. */
export function listIndexes(db: DatabaseSync): IndexInfo[] {
  const rows = db
    .prepare(
      `SELECT name, tbl_name FROM sqlite_schema
        WHERE type = 'index' AND sql IS NOT NULL
        ORDER BY name`,
    )
    .all();
  return rows.map((row) => {
    const name = asString(row['name']);
    const table = asString(row['tbl_name']);
    const meta = db
      .prepare(`SELECT "unique", partial FROM pragma_index_list(?) WHERE name = ?`)
      .get(table, name);
    return {
      name,
      table,
      unique: meta?.['unique'] === 1,
      partial: meta?.['partial'] === 1,
    };
  });
}

/** The `CREATE TABLE` statement as SQLite stored it — the only place `CHECK` text lives. */
export function tableSql(db: DatabaseSync, table: string): string {
  const row = db
    .prepare(`SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?`)
    .get(table);
  return asString(row?.['sql']);
}

export function describeTable(db: DatabaseSync, table: string): TableInfo {
  const columns = db
    .prepare(`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?)`)
    .all(table)
    .map((row): ColumnInfo => {
      const dflt = row['dflt_value'];
      return {
        name: asString(row['name']),
        declaredType: asString(row['type']),
        notNull: asInteger(row['notnull']) === 1,
        hasDefault: dflt !== null && dflt !== undefined,
        primaryKeyPosition: asInteger(row['pk']),
      };
    });
  if (columns.length === 0) throw new Error(`no such table: ${table}`);

  const primaryKey = columns
    .filter((column) => column.primaryKeyPosition > 0)
    .sort((a, b) => a.primaryKeyPosition - b.primaryKeyPosition)
    .map((column) => column.name);

  const foreignKeys = db
    .prepare(`SELECT "table", "from", "to", on_delete FROM pragma_foreign_key_list(?)`)
    .all(table)
    .map((row): ForeignKeyInfo => ({
      column: asString(row['from']),
      parentTable: asString(row['table']),
      parentColumn: asString(row['to']),
      onDelete: asString(row['on_delete']),
    }))
    .sort((a, b) => (a.column < b.column ? -1 : a.column > b.column ? 1 : 0));

  return { name: table, columns, primaryKey, foreignKeys };
}

export function describeTables(db: DatabaseSync): TableInfo[] {
  return listTables(db).map((table) => describeTable(db, table));
}

/**
 * Tables in foreign-key-safe insert order: a table never appears before a table it
 * references. Ties break on the table name so the order is deterministic, and a
 * self-reference is ignored because it is satisfied within one table's own rows rather
 * than across tables — so adding one later cannot deadlock this sort.
 *
 * Computing this beats writing it down: a new foreign key reorders the load for free.
 */
export function tableLoadOrder(db: DatabaseSync): string[] {
  const tables = describeTables(db);
  const pending = new Map<string, Set<string>>();
  for (const table of tables) {
    const parents = new Set<string>();
    for (const fk of table.foreignKeys) {
      if (fk.parentTable !== table.name) parents.add(fk.parentTable);
    }
    pending.set(table.name, parents);
  }

  const ordered: string[] = [];
  const placed = new Set<string>();
  while (pending.size > 0) {
    const ready = [...pending.entries()]
      .filter(([, parents]) => [...parents].every((parent) => placed.has(parent)))
      .map(([name]) => name)
      .sort();
    const next = ready[0];
    if (next === undefined) {
      throw new Error(`foreign key cycle across tables: ${[...pending.keys()].sort().join(', ')}`);
    }
    for (const name of ready) {
      ordered.push(name);
      placed.add(name);
      pending.delete(name);
    }
  }
  return ordered;
}
