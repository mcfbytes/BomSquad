import { type Provider } from '@angular/core';

import {
  DATABASE_CONFIG,
  DATABASE_FETCH,
  type DatabaseFetch,
  SQL_ENGINE_FACTORY,
  type SqlEngineFactory,
} from '../app/data/database';
import { createSqliteWasmEngine } from '../app/data/sqlite-wasm-engine';
import { SEARCH_DEBOUNCE_MS } from '../app/search/global-search';
import { FIXTURE_SQLITE_WASM_PATH, fixtureDatabaseBytes } from './fixture-database';

/** Counts every call, so "no second network fetch" can be asserted rather than assumed. */
export interface FetchLog {
  readonly calls: readonly string[];
}

export interface FixtureDatabaseOptions {
  /** Force a failure instead of serving the fixture. */
  readonly respondWith?: Response | (() => Response);
  /** Reject the request outright, as an offline browser would. */
  readonly rejectWith?: Error;
  /** Debounce for `GlobalSearch`; 0 keeps keyboard tests synchronous. */
  readonly debounceMs?: number;
}

/**
 * TestBed providers that point the data layer at the fixture database.
 *
 * The engine is the **real** `@sqlite.org/sqlite-wasm` — same library, same
 * `sqlite3_deserialize` call, same SQL dialect as production. Only two things are
 * swapped: `fetch` serves the fixture bytes from memory, and `locateFile` points at
 * the wasm on disk rather than at `/site-data/sqlite3.wasm`.
 */
export function provideFixtureDatabase(options: FixtureDatabaseOptions = {}): {
  readonly providers: Provider[];
  readonly log: FetchLog;
} {
  const calls: string[] = [];
  const log: FetchLog = { calls };

  const httpGet: DatabaseFetch = (url) => {
    calls.push(url);
    if (options.rejectWith !== undefined) {
      return Promise.reject(options.rejectWith);
    }
    if (options.respondWith !== undefined) {
      const response =
        typeof options.respondWith === 'function' ? options.respondWith() : options.respondWith;
      return Promise.resolve(response.clone());
    }
    const bytes = fixtureDatabaseBytes();
    return Promise.resolve(
      new Response(bytes.slice().buffer, {
        status: 200,
        headers: {
          'content-type': 'application/vnd.sqlite3',
          'content-length': String(bytes.byteLength),
        },
      }),
    );
  };

  const factory: SqlEngineFactory = (bytes, wasmUrl) => createSqliteWasmEngine(bytes, wasmUrl);

  return {
    log,
    providers: [
      {
        provide: DATABASE_CONFIG,
        useValue: {
          databaseUrl: '/site-data/bomsquad.sqlite',
          sqliteWasmUrl: FIXTURE_SQLITE_WASM_PATH,
        },
      },
      { provide: DATABASE_FETCH, useValue: httpGet },
      { provide: SQL_ENGINE_FACTORY, useValue: factory },
      { provide: SEARCH_DEBOUNCE_MS, useValue: options.debounceMs ?? 0 },
    ],
  };
}

/** A 404, for the "the deploy step did not run" path. */
export function notFoundResponse(): Response {
  return new Response('Not Found', { status: 404, statusText: 'Not Found' });
}

/** A 200 full of the SPA shell — what a misconfigured navigation fallback returns. */
export function indexHtmlResponse(): Response {
  return new Response('<!doctype html><html><body><app-root></app-root></body></html>', {
    status: 200,
    headers: { 'content-type': 'text/html' },
  });
}
