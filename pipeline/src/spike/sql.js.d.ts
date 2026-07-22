/**
 * SPIKE — minimal ambient types for `sql.js`, used only by
 * `verify-browser-engines.ts`.
 *
 * `sql.js` ships no types of its own; the community package `@types/sql.js` is a
 * separate install and ADR 0001 counts that against it. Rather than add a
 * dependency for a throwaway spike, this declares exactly the four calls the
 * spike makes. Delete it with the spike.
 */
declare module 'sql.js' {
  export interface SqlJsConfig {
    /** Maps a bare asset name (`sql-wasm.wasm`) to a loadable path. */
    locateFile?: (file: string) => string;
  }

  export interface QueryExecResult {
    columns: string[];
    values: unknown[][];
  }

  export interface Statement {
    step(): boolean;
    get(): unknown[];
    free(): boolean;
  }

  export class Database {
    constructor(data?: Uint8Array);
    exec(sql: string): QueryExecResult[];
    prepare(sql: string): Statement;
    run(sql: string): Database;
    close(): void;
  }

  export interface SqlJsStatic {
    Database: typeof Database;
  }

  const initSqlJs: (config?: SqlJsConfig) => Promise<SqlJsStatic>;
  export default initSqlJs;
}
