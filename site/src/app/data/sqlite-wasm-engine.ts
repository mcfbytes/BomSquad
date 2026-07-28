import { type SqlEngine, type SqlParams, SqlQueryError } from './sql';

/**
 * The only module in the app that touches `@sqlite.org/sqlite-wasm`.
 *
 * It is reached exclusively through `await import('./sqlite-wasm-engine')` from
 * `database.ts`, and the library itself is reached through a second dynamic import
 * below. Both indirections exist for one reason: the module is 578 kB of JavaScript
 * plus an 865 kB `.wasm`, and `angular.json` budgets the initial bundle at 500 kB.
 * A static import anywhere on a path the app shell can reach would put all of it in
 * `main.js` and blow the budget on every route, including the ones that need no
 * data at all.
 *
 * The load path is ADR 0001's, verbatim: one `fetch` of the whole file,
 * `sqlite3_deserialize` into an in-memory database, no OPFS, no `SharedArrayBuffer`
 * and therefore no COOP/COEP.
 */

/**
 * Where the wasm binary is served from.
 *
 * `@sqlite.org/sqlite-wasm` otherwise resolves `sqlite3.wasm` against
 * `import.meta.url`, which after bundling is the hashed chunk's own URL at the
 * deploy root — `/sqlite3.wasm`. That path is **not** in
 * `staticwebapp.config.json`'s `navigationFallback.exclude` list, so Azure Static
 * Web Apps would rewrite it to `index.html` and the browser would try to compile
 * HTML as WebAssembly. Pointing `locateFile` at `/site-data/` puts the binary
 * behind the exclusion rule that already exists, and keeps the wasm's location a
 * decision this app makes rather than a side effect of chunk naming.
 */
export const DEFAULT_SQLITE_WASM_URL = '/site-data/sqlite3.wasm';

/**
 * `@sqlite.org/sqlite-wasm` types its default export as `init(): Promise<…>`, but
 * the runtime function is an Emscripten module factory and takes the usual module
 * configuration object. `locateFile` is the part we need, and it is the part the
 * published `.d.mts` does not describe.
 */
interface SqliteModuleConfig {
  locateFile?: (path: string) => string;
  print?: (message: string) => void;
  printErr?: (message: string) => void;
}

/** Opens the downloaded bytes as a read-only in-memory database. */
export async function createSqliteWasmEngine(
  bytes: Uint8Array,
  wasmUrl: string = DEFAULT_SQLITE_WASM_URL,
): Promise<SqlEngine> {
  const { default: init } = await import('@sqlite.org/sqlite-wasm');

  const sqlite3 = await (
    init as unknown as (config: SqliteModuleConfig) => ReturnType<typeof init>
  )({
    locateFile: () => wasmUrl,
    // The library logs its banner and its OPFS probe results to the console on
    // every start. We use neither OPFS nor the banner.
    print: () => undefined,
    printErr: () => undefined,
  });

  const pointer = sqlite3.wasm.allocFromTypedArray(bytes);
  const db = new sqlite3.oo1.DB();
  const connection = db.pointer;
  if (connection === undefined) {
    throw new Error('sqlite3 opened a connection with no pointer.');
  }
  const rc = sqlite3.capi.sqlite3_deserialize(
    connection,
    'main',
    pointer,
    bytes.byteLength,
    bytes.byteLength,
    // FREEONCLOSE hands the wasm-heap allocation back when the connection closes.
    // READONLY is the honest declaration: the database is rebuilt by CI and
    // republished, nothing in the SPA writes, and a stray UPDATE should fail loudly
    // rather than mutate a copy that silently disappears on reload.
    sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_READONLY,
  );
  if (rc !== sqlite3.capi.SQLITE_OK) {
    db.close();
    throw new Error(`sqlite3_deserialize() failed with result code ${rc}.`);
  }

  return {
    // See the rationale on `SqlEngine.select` in ./sql.ts.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
    select<T>(sql: string, params?: SqlParams): readonly T[] {
      try {
        // Two call shapes rather than one with `bind: undefined`:
        // `exactOptionalPropertyTypes` makes an explicit `undefined` illegal for
        // an optional property, and the resulting mismatch silently selects the
        // wrong `exec()` overload.
        const rows =
          params === undefined
            ? db.exec({ sql, rowMode: 'object', returnValue: 'resultRows' })
            : db.exec({
                sql,
                bind: { ...params },
                rowMode: 'object',
                returnValue: 'resultRows',
              });
        return rows as unknown as readonly T[];
      } catch (error) {
        throw new SqlQueryError(sql, error instanceof Error ? error.message : String(error), {
          cause: error,
        });
      }
    },
    close(): void {
      db.close();
    },
  };
}
