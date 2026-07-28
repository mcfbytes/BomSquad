import { InjectionToken, Injectable, computed, inject, signal } from '@angular/core';

import {
  DatabaseLoadError,
  type SqlEngine,
  type SqlParams,
  SqlQueryError,
  type SqlValue,
} from './sql';

/**
 * Where the two runtime assets live, relative to the deploy root.
 *
 * Both sit under `/site-data/`, which `site/public/staticwebapp.config.json`
 * already excludes from the SPA navigation fallback — so a request for either gets
 * the file, not `index.html`. `site/tools/stage-data-assets.mjs` puts them there at
 * build time; see site/README.md, "The database asset".
 */
export interface DatabaseConfig {
  readonly databaseUrl: string;
  readonly sqliteWasmUrl: string;
}

export const DATABASE_CONFIG = new InjectionToken<DatabaseConfig>('bomsquad.database-config', {
  providedIn: 'root',
  factory: () => ({
    databaseUrl: '/site-data/bomsquad.sqlite',
    sqliteWasmUrl: '/site-data/sqlite3.wasm',
  }),
});

/** Injectable `fetch`, so a test can serve a fixture without patching globals. */
export type DatabaseFetch = (url: string, init: RequestInit) => Promise<Response>;

export const DATABASE_FETCH = new InjectionToken<DatabaseFetch>('bomsquad.database-fetch', {
  providedIn: 'root',
  factory: (): DatabaseFetch => (url, init) => fetch(url, init),
});

export type SqlEngineFactory = (bytes: Uint8Array, wasmUrl: string) => Promise<SqlEngine>;

/**
 * How the downloaded bytes become a queryable database.
 *
 * The default reaches `@sqlite.org/sqlite-wasm` through a dynamic import, which is
 * what keeps 1.4 MB of engine out of the initial chunk. Tests override this token
 * with a `node:sqlite` engine over a fixture database — same SQL, same row shapes,
 * no wasm download inside a unit test.
 */
export const SQL_ENGINE_FACTORY = new InjectionToken<SqlEngineFactory>(
  'bomsquad.sql-engine-factory',
  {
    providedIn: 'root',
    factory: (): SqlEngineFactory => async (bytes, wasmUrl) => {
      const { createSqliteWasmEngine } = await import('./sqlite-wasm-engine');
      return createSqliteWasmEngine(bytes, wasmUrl);
    },
  },
);

export type DatabaseStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface DatabaseProgress {
  readonly receivedBytes: number;
  /** `null` when the response carried no usable `Content-Length`. */
  readonly totalBytes: number | null;
}

/**
 * Owns the single database download and the connection opened from it (T7.2).
 *
 * ADR 0001: one `fetch` of the whole `dist/bomsquad.sqlite`, `sqlite3_deserialize`
 * into memory, no manifest, no chunking, no range requests. That means exactly one
 * network request can fail for the entire data layer, and this class is where that
 * failure becomes a signal the UI can render instead of a blank page.
 *
 * Nothing here blocks the app shell. `preload()` is a hint, `ensureLoaded()` is
 * idempotent and shared, and a route that needs no data never touches either.
 */
@Injectable({ providedIn: 'root' })
export class DatabaseService {
  private readonly config = inject(DATABASE_CONFIG);
  private readonly httpGet = inject(DATABASE_FETCH);
  private readonly createEngine = inject(SQL_ENGINE_FACTORY);

  private readonly state = signal<DatabaseStatus>('idle');
  private readonly loadProgress = signal<DatabaseProgress | null>(null);
  private readonly failure = signal<DatabaseLoadError | null>(null);
  private readonly loadedAt = signal<number | null>(null);

  /** In flight or settled; `null` until the first `ensureLoaded()` / `preload()`. */
  private pending: Promise<SqlEngine> | null = null;
  private engine: SqlEngine | null = null;

  readonly status = this.state.asReadonly();
  readonly progress = this.loadProgress.asReadonly();
  readonly error = this.failure.asReadonly();
  readonly isReady = computed(() => this.state() === 'ready');
  readonly isLoading = computed(() => this.state() === 'loading');
  /** Wall-clock milliseconds from request to first queryable row. */
  readonly loadDurationMs = this.loadedAt.asReadonly();

  /** Fraction in [0, 1], or `null` while the total size is unknown. */
  readonly progressFraction = computed(() => {
    const progress = this.loadProgress();
    const total = progress?.totalBytes ?? 0;
    if (progress === null || total <= 0) {
      return null;
    }
    // A compressed response reports the *encoded* length in Content-Length while
    // the reader yields decoded bytes, so this can legitimately exceed 1.
    return Math.min(1, progress.receivedBytes / total);
  });

  /**
   * Starts the download in the background if it has not started already.
   *
   * Called once by the app shell after first render. The shell hosts the global
   * search box (T7.3), which is available on every route, so the database is needed
   * on every route — but nothing waits for it, and a visitor who only opens
   * `/contribute` gets a fully rendered page either way.
   *
   * Skipped when the visitor has asked the browser to conserve data: 5.7 MB
   * speculatively is not a reasonable thing to do to a metered connection. Those
   * visitors still get the database, on the first query that needs it.
   */
  preload(): void {
    if (this.pending !== null || prefersReducedData()) {
      return;
    }
    void this.ensureLoaded().catch(() => undefined);
  }

  /** Resolves once the database is queryable; rejects with a `DatabaseLoadError`. */
  ensureLoaded(): Promise<SqlEngine> {
    this.pending ??= this.load();
    return this.pending;
  }

  /** Throws the last failure away and downloads again. */
  retry(): void {
    if (this.state() === 'loading') {
      return;
    }
    this.pending = null;
    this.failure.set(null);
    this.state.set('idle');
    void this.ensureLoaded().catch(() => undefined);
  }

  /**
   * Runs one statement and returns its rows.
   *
   * Async because the database may still be downloading; the query itself is
   * synchronous once it is not. `T` is the caller's claim about the row shape —
   * use the generated `TableRowTypes` / `ViewRowTypes` entries rather than writing
   * one out by hand.
   */
  async select<T>(sql: string, params?: SqlParams): Promise<readonly T[]> {
    const engine = await this.ensureLoaded();
    return engine.select<T>(sql, params);
  }

  /** The first row, or `null`. Rejects if the statement itself is bad. */
  async selectOne<T>(sql: string, params?: SqlParams): Promise<T | null> {
    const rows = await this.select<T>(sql, params);
    return rows[0] ?? null;
  }

  /** A single scalar from a single row — `SELECT COUNT(*) AS value FROM …`. */
  async selectValue<T extends SqlValue>(sql: string, params?: SqlParams): Promise<T | null> {
    const row = await this.selectOne<Record<string, T>>(sql, params);
    if (row === null) {
      return null;
    }
    const values = Object.values(row);
    if (values.length !== 1) {
      throw new SqlQueryError(sql, 'selectValue() expects a statement with exactly one column.');
    }
    return values[0] ?? null;
  }

  private async load(): Promise<SqlEngine> {
    this.state.set('loading');
    this.failure.set(null);
    this.loadProgress.set({ receivedBytes: 0, totalBytes: null });

    const startedAt = performance.now();
    try {
      const bytes = await this.download();
      const engine = await this.openEngine(bytes);
      this.engine = engine;
      this.loadedAt.set(Math.round(performance.now() - startedAt));
      this.state.set('ready');
      return engine;
    } catch (error) {
      const failure =
        error instanceof DatabaseLoadError
          ? error
          : new DatabaseLoadError('engine', this.config.databaseUrl, describe(error), {
              cause: error,
            });
      this.failure.set(failure);
      this.state.set('error');
      throw failure;
    }
  }

  private async download(): Promise<Uint8Array> {
    const url = this.config.databaseUrl;

    let response: Response;
    try {
      response = await this.httpGet(url, { credentials: 'omit' });
    } catch (error) {
      throw new DatabaseLoadError(
        'network',
        url,
        `The database could not be reached (${describe(error)}).`,
        { cause: error },
      );
    }

    if (!response.ok) {
      throw new DatabaseLoadError(
        'http',
        url,
        `The server answered ${response.status} ${response.statusText} for the database.`,
      );
    }

    const declared = Number(response.headers.get('content-length'));
    const totalBytes = Number.isFinite(declared) && declared > 0 ? declared : null;
    this.loadProgress.set({ receivedBytes: 0, totalBytes });

    const body = response.body;
    if (body === null) {
      // No streaming body: a `Response` built by hand in a test, or a browser that
      // did not give us one. Still perfectly loadable, just without progress.
      const buffer = await response.arrayBuffer();
      this.loadProgress.set({ receivedBytes: buffer.byteLength, totalBytes });
      return new Uint8Array(buffer);
    }

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
      received += value.byteLength;
      this.loadProgress.set({ receivedBytes: received, totalBytes });
    }

    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  private async openEngine(bytes: Uint8Array): Promise<SqlEngine> {
    // A 404 rewritten to index.html by a misconfigured host arrives as a 200 full
    // of HTML. Checking the 16-byte header turns that into a sentence a maintainer
    // can act on rather than an opaque "not a database file" from deep in wasm.
    if (!isSqliteFile(bytes)) {
      throw new DatabaseLoadError(
        'http',
        this.config.databaseUrl,
        `${this.config.databaseUrl} did not return a SQLite database. ` +
          'The deploy step that copies dist/bomsquad.sqlite into the site has probably not run.',
      );
    }
    try {
      return await this.createEngine(bytes, this.config.sqliteWasmUrl);
    } catch (error) {
      throw new DatabaseLoadError(
        'engine',
        this.config.databaseUrl,
        `The database downloaded but could not be opened (${describe(error)}).`,
        { cause: error },
      );
    }
  }

  /** Test seam: drops the connection so the next `ensureLoaded()` starts over. */
  reset(): void {
    this.engine?.close();
    this.engine = null;
    this.pending = null;
    this.state.set('idle');
    this.failure.set(null);
    this.loadProgress.set(null);
    this.loadedAt.set(null);
  }
}

/** `SQLite format 3\0`, the first 16 bytes of every SQLite database file. */
const SQLITE_MAGIC = 'SQLite format 3\0';

function isSqliteFile(bytes: Uint8Array): boolean {
  if (bytes.byteLength < SQLITE_MAGIC.length) {
    return false;
  }
  for (let index = 0; index < SQLITE_MAGIC.length; index += 1) {
    if (bytes[index] !== SQLITE_MAGIC.charCodeAt(index)) {
      return false;
    }
  }
  return true;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `navigator.connection.saveData`, defensively — it is not in every browser. */
function prefersReducedData(): boolean {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return connection?.saveData === true;
}
