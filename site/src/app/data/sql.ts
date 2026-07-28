/**
 * The vocabulary shared by the database service, the SQLite engine adapter and
 * every consumer of them. Deliberately tiny and free of Angular and of
 * `@sqlite.org/sqlite-wasm`: this module is in the initial bundle, and the engine
 * is not (see `sqlite-wasm-engine.ts`).
 */

/**
 * A value that can be bound to a statement parameter.
 *
 * The shipped schema is `STRICT`, and every column in it is `TEXT`, `INTEGER` or
 * `REAL` — there is no `BLOB` and no `ANY` column anywhere in `schemas/schema.sql`,
 * so no query in this app has cause to bind or read one.
 */
export type SqlValue = string | number | null;

/** Named bind parameters. Keys carry their `:` prefix, as SQLite expects. */
export type SqlParams = Readonly<Record<string, SqlValue>>;

/** A statement plus its bindings — the unit `query()` caches and re-runs. */
export interface QuerySpec {
  readonly sql: string;
  readonly params?: SqlParams;
}

/**
 * A read-only SQLite connection over the already-downloaded database.
 *
 * Synchronous on purpose: the engine is `sqlite3_deserialize`'d into the wasm heap
 * and every query is a main-thread B-tree walk over memory. `DatabaseService`
 * wraps it in promises so the seam can move to a worker later without any consumer
 * changing.
 */
export interface SqlEngine {
  /**
   * `T` is the caller's claim about the row shape, exactly as it is in every typed
   * database client: SQLite hands back untyped values and the generated row types
   * say what they mean. The lint rule below objects to a type parameter that
   * appears only in the return position, and it is right that this is an
   * assertion — `view-types.spec.ts` is where that assertion is checked, against a
   * real database rather than against itself.
   */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  select<T>(sql: string, params?: SqlParams): readonly T[];
  close(): void;
}

/** Why the one fetch that can fail, failed. Drives the wording of the error state. */
export type DatabaseFailureKind =
  /** The request never completed: offline, DNS, CORS, aborted. */
  | 'network'
  /** The server answered, but not with a database: 404 from a missing deploy step. */
  | 'http'
  /** The bytes arrived but SQLite would not open them. */
  | 'engine';

/**
 * A load failure with enough detail to be actionable on screen.
 *
 * The three kinds have genuinely different remedies — retry, tell the maintainer
 * the deploy is broken, upgrade the browser — so a single "something went wrong"
 * would be a worse error than none at all.
 */
export class DatabaseLoadError extends Error {
  readonly kind: DatabaseFailureKind;
  readonly url: string;

  constructor(kind: DatabaseFailureKind, url: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DatabaseLoadError';
    this.kind = kind;
    this.url = url;
  }
}

/**
 * A statement that the engine refused.
 *
 * The acceptance criterion this exists for is "a query against a missing view
 * surfaces a user-visible error state, not a blank page": SQLite answers
 * `no such table: v_typo` and that message is worth showing verbatim, because the
 * only person who can act on it is a developer reading a bug report.
 */
export class SqlQueryError extends Error {
  readonly sql: string;

  constructor(sql: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SqlQueryError';
    this.sql = sql;
  }
}

/**
 * Escapes a user-typed string for use inside a `LIKE` pattern with `ESCAPE '\'`.
 *
 * Without this, typing `%` matches everything and typing `_` matches any single
 * character — surprising, and on a 9 775-row table also slow.
 */
export function escapeLikePattern(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}
