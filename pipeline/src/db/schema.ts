/**
 * Applies `schemas/schema.sql` to a SQLite database.
 *
 * Node 24 ships SQLite as `node:sqlite` (`DatabaseSync`, synchronous, no callbacks),
 * which covers everything the build needs — multi-statement `exec`, named parameters,
 * `PRAGMA foreign_key_check`, `integrity_check`, `ANALYZE`, `VACUUM`, `dbstat`. There
 * is therefore no native dependency here and no new npm package.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Repository root, resolved from this module. `src/db` and `dist/db` are both three deep. */
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

/** Absolute path to the one normative DDL file. */
export const SCHEMA_PATH = join(REPO_ROOT, 'schemas', 'schema.sql');

/** Directory holding the row-file JSON Schemas. */
export const SCHEMAS_DIR = join(REPO_ROOT, 'schemas');

/**
 * Spec version of `docs/data-model.md` that `schema.sql` implements. A dataset states
 * its own `dataset_meta.schema_version`; this constant is what the build stamps there.
 * The database stores the version once, as `PRAGMA user_version` — there is no
 * `schema_version` table, and therefore nothing to reconcile.
 */
export const SCHEMA_VERSION = '2.0.0';

/** `PRAGMA user_version`, which by convention carries the schema's major component. */
export const SCHEMA_USER_VERSION = 2;

export function readSchemaSql(): string {
  return readFileSync(SCHEMA_PATH, 'utf8');
}

/**
 * Executes the DDL. `exec` runs every statement in the file, including the leading
 * `PRAGMA page_size` / `encoding` (which must precede the first table for the file
 * layout to be deterministic) and `PRAGMA user_version`.
 *
 * `PRAGMA foreign_keys = ON` is a **silent no-op inside a transaction**: SQLite ignores
 * it between `BEGIN` and `COMMIT` and reports no error, so a caller that wrapped the DDL
 * would ship a database with no referential enforcement at all and never find out. The
 * pragma is therefore read back here and a failure to take effect is fatal.
 */
export function applySchema(db: DatabaseSync): void {
  db.exec(readSchemaSql());
  if (db.prepare('PRAGMA foreign_keys').get()?.['foreign_keys'] !== 1) {
    throw new Error(
      'PRAGMA foreign_keys did not take effect: the schema was applied inside a transaction, ' +
        'where SQLite ignores it silently. Apply schemas/schema.sql outside BEGIN/COMMIT.',
    );
  }
}

/**
 * Opens a database and applies the schema. Pass `':memory:'` for tests; pass a path
 * for a build. The caller owns closing it.
 */
export function createSchemaDatabase(location = ':memory:'): DatabaseSync {
  const db = new DatabaseSync(location);
  applySchema(db);
  return db;
}

/**
 * `PRAGMA foreign_key_check` and `PRAGMA integrity_check` in one call. Returns a list
 * of human-readable problems; empty means the database is sound. These two pragmas are
 * the whole of referential-integrity validation (data-model.md §5.4) — nothing in this
 * repository re-implements a dangling-reference scan.
 */
export function checkIntegrity(db: DatabaseSync): string[] {
  const problems: string[] = [];
  for (const row of db.prepare('PRAGMA foreign_key_check').all()) {
    problems.push(
      `foreign key violation: ${String(row['table'])} row references missing ${String(row['parent'])}`,
    );
  }
  for (const row of db.prepare('PRAGMA integrity_check').all()) {
    const result = row['integrity_check'];
    if (result !== 'ok') problems.push(`integrity_check: ${String(result)}`);
  }
  return problems;
}
