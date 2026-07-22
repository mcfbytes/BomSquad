/**
 * SPIKE — the evidence behind ADR 0001 (docs/adr/0001-browser-database.md).
 *
 * Not part of the pipeline. Nothing imports it; the CLI does not dispatch it;
 * no test runs it. It exists so that every engine number quoted in ADR 0001 is
 * one anyone can reproduce in one command.
 *
 * Run:  npx tsx pipeline/src/spike/verify-browser-engines.ts
 *
 * What it does, for each of the three engines — Node's built-in `node:sqlite`,
 * `@sqlite.org/sqlite-wasm` and `sql.js`:
 *
 *   1. Reports the SQLite version the engine actually bundles, read out of the
 *      engine at runtime (`SELECT sqlite_version()`), not out of a changelog.
 *   2. Applies the WHOLE shipped `schemas/schema.sql` to an empty database and
 *      counts the objects that resulted, so "the engine accepts our schema"
 *      means all 36 tables and all 21 views, not a 14-view extract.
 *   3. Executes every view once, so a view that parses but cannot run is caught.
 *      This is what proves the coverage and quality views work in a browser
 *      engine — they hold the schema's only `julianday()` call, which is also
 *      probed directly.
 *   4. Loads the prebuilt fixture database — the browser's real load path:
 *      `sqlite3_deserialize()` for sqlite-wasm, `new SQL.Database(bytes)` for
 *      sql.js — and runs the canonical queries, timing each and hashing its
 *      full result set so cross-engine agreement is checked on values, not on
 *      row counts alone.
 *
 * Delete it with `build-fixture-db.ts` once ADR 0001 is spent.
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import initSqlJs from 'sql.js';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

import { CANONICAL_QUERIES, buildFixtureDatabase, schemaSql } from './build-fixture-db.js';

/* ------------------------------------------------------------- interfaces */

type Rows = unknown[][];

/** The three engines reduced to the two calls this spike needs. */
interface Session {
  exec: (sql: string) => void;
  rows: (sql: string) => Rows;
  close: () => void;
}

interface EngineReport {
  label: string;
  packageVersion: string;
  sqliteVersion: string;
  objects: Record<string, number>;
  viewsExecuted: number;
  julianday: unknown;
  loadMs: number;
  timings: Map<string, { rows: number; hash: string; bestMs: number; medianMs: number }>;
}

const RUNS = 5;

/* ------------------------------------------------------------ small utils */

const require = createRequire(import.meta.url);

/** FNV-1a over the JSON of every row. Cheap, and it compares values, not counts. */
function hashRows(rows: Rows): string {
  let h = 0x811c9dc5;
  for (const row of rows) {
    const s = JSON.stringify(row);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h.toString(16).padStart(8, '0');
}

function measure(
  session: Session,
  sql: string,
): { rows: number; hash: string; bestMs: number; medianMs: number } {
  // Correctness first, outside the clock.
  const materialised = session.rows(sql);
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    session.rows(sql);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return {
    rows: materialised.length,
    hash: hashRows(materialised),
    bestMs: times[0] ?? 0,
    medianMs: times[Math.floor(times.length / 2)] ?? 0,
  };
}

const scalar = (session: Session, sql: string): unknown => session.rows(sql)[0]?.[0];

/** sqlite_master, grouped the way the schema.sql header line counts itself. */
function objectCounts(session: Session): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [type, n] of session.rows(
    'SELECT type, COUNT(*) FROM sqlite_master WHERE sql IS NOT NULL GROUP BY type ORDER BY type',
  )) {
    out[String(type)] = Number(n);
  }
  return out;
}

/** Runs every view once. Returns how many ran; throws naming the first that did not. */
function executeEveryView(session: Session, label: string): number {
  const views = session
    .rows("SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name")
    .map((r) => String(r[0]));
  for (const v of views) {
    try {
      session.rows(`SELECT COUNT(*) FROM (SELECT * FROM ${v} LIMIT 1)`);
    } catch (err) {
      throw new Error(`${label}: view ${v} does not execute`, { cause: err });
    }
  }
  return views.length;
}

/* --------------------------------------------------------- engine: node */

function nodeSession(db: DatabaseSync): Session {
  return {
    exec: (sql) => {
      db.exec(sql);
    },
    rows: (sql) =>
      db
        .prepare(sql)
        .all()
        .map((r) => Object.values(r as Record<string, unknown>)),
    close: () => {
      db.close();
    },
  };
}

/* ---------------------------------------------------- engine: sqlite-wasm */

/**
 * The exact browser load path. `allocFromTypedArray` copies the fetched bytes
 * into the wasm heap and `sqlite3_deserialize` adopts that allocation as the
 * `main` database; FREEONCLOSE hands the allocation back when the db closes and
 * RESIZEABLE lets SQLite grow it (a temp b-tree during an ORDER BY needs that).
 */
async function sqliteWasm(): Promise<{
  version: string;
  open: (bytes: Uint8Array | null) => Session;
}> {
  const sqlite3 = await sqlite3InitModule();
  return {
    version: sqlite3.version.libVersion,
    open: (bytes) => {
      const db = new sqlite3.oo1.DB();
      if (bytes !== null) {
        const p = sqlite3.wasm.allocFromTypedArray(bytes);
        const rc = sqlite3.capi.sqlite3_deserialize(
          db.pointer ?? 0,
          'main',
          p,
          bytes.byteLength,
          bytes.byteLength,
          sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE,
        );
        if (rc !== 0) throw new Error(`sqlite3_deserialize returned ${String(rc)}`);
      }
      return {
        exec: (sql) => {
          db.exec(sql);
        },
        rows: (sql) => db.exec({ sql, rowMode: 'array', returnValue: 'resultRows' }),
        close: () => {
          db.close();
        },
      };
    },
  };
}

/* --------------------------------------------------------- engine: sql.js */

async function sqlJs(): Promise<{ open: (bytes: Uint8Array | null) => Session }> {
  const SQL = await initSqlJs({ locateFile: (file) => join(SQL_JS_DIST, file) });
  return {
    open: (bytes) => {
      const db = bytes === null ? new SQL.Database() : new SQL.Database(bytes);
      return {
        exec: (sql) => {
          db.run(sql);
        },
        rows: (sql) => {
          const st = db.prepare(sql);
          const out: Rows = [];
          while (st.step()) out.push(st.get());
          st.free();
          return out;
        },
        close: () => {
          db.close();
        },
      };
    },
  };
}

/* ------------------------------------------------- wire cost of the engine */

/** Raw / gzip -9 / brotli -q 11 bytes of the files a browser must download. */
function payload(files: readonly string[]): { raw: number; gzip: number; brotli: number } {
  let raw = 0;
  let gzip = 0;
  let brotli = 0;
  for (const f of files) {
    const bytes = readFileSync(f);
    raw += bytes.byteLength;
    gzip += gzipSync(bytes, { level: 9 }).byteLength;
    brotli += brotliCompressSync(bytes, {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
    }).byteLength;
  }
  return { raw, gzip, brotli };
}

/* ------------------------------------------------------------------ main */

function reportOn(
  label: string,
  packageVersion: string,
  open: (b: Uint8Array | null) => Session,
  bytes: Uint8Array,
): EngineReport {
  // 1. The schema, applied whole to an empty database.
  const fresh = open(null);
  fresh.exec(schemaSql());
  const objects = objectCounts(fresh);
  const viewsExecuted = executeEveryView(fresh, label);
  const sqliteVersion = String(scalar(fresh, 'SELECT sqlite_version()'));
  // The schema's only julianday() use is IMPL_STALE_REVIEW in v_quality_warning.
  const julianday = scalar(fresh, "SELECT julianday('2026-07-22') - julianday('2019-01-15')");
  fresh.close();

  // 2. The prebuilt database, loaded the way the browser will load it.
  //    The clock covers only the load itself — for sqlite-wasm the copy into the
  //    wasm heap plus sqlite3_deserialize, for sql.js the Database constructor.
  const tLoad = performance.now();
  const loaded = open(bytes);
  const loadMs = performance.now() - tLoad;
  const timings = new Map<
    string,
    { rows: number; hash: string; bestMs: number; medianMs: number }
  >();
  for (const q of CANONICAL_QUERIES) timings.set(q.id, measure(loaded, q.sql));
  loaded.close();

  return {
    label,
    packageVersion,
    sqliteVersion,
    objects,
    viewsExecuted,
    julianday,
    loadMs,
    timings,
  };
}

/** Reads the installed version out of a package.json path. */
function versionAt(packageJsonPath: string): string {
  const meta = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: string };
  return meta.version ?? 'unknown';
}

/** sql.js does not export './package.json', so the path is derived from dist/. */
const SQL_JS_DIST = dirname(require.resolve('sql.js/dist/sql-wasm.js'));

async function main(): Promise<void> {
  console.log('building the fixture (schemas/schema.sql, verbatim) …');
  const path = buildFixtureDatabase();
  const bytes = new Uint8Array(readFileSync(path));
  console.log(`fixture: ${path}  ${String(bytes.byteLength)} bytes\n`);

  const reports: EngineReport[] = [];

  const nodeVersion = process.versions.node;
  reports.push(
    reportOn(
      'node:sqlite',
      `node ${nodeVersion}`,
      // node:sqlite exposes no deserialize(); the build-side equivalent of the
      // browser's "load these bytes" is opening the file read-only.
      (b) =>
        nodeSession(
          b === null ? new DatabaseSync(':memory:') : new DatabaseSync(path, { readOnly: true }),
        ),
      bytes,
    ),
  );

  const wasm = await sqliteWasm();
  reports.push(
    reportOn(
      '@sqlite.org/sqlite-wasm',
      versionAt(require.resolve('@sqlite.org/sqlite-wasm/package.json')),
      wasm.open,
      bytes,
    ),
  );

  const js = await sqlJs();
  reports.push(
    reportOn('sql.js', versionAt(join(SQL_JS_DIST, '..', 'package.json')), js.open, bytes),
  );

  /* ---- report */

  console.log(
    'engine                     package                 SQLite   objects (sqlite_master)          views run  julianday',
  );
  for (const r of reports) {
    const objs = Object.entries(r.objects)
      .map(([k, v]) => `${String(v)} ${k}`)
      .join(' · ');
    console.log(
      `${r.label.padEnd(26)} ${r.packageVersion.padEnd(23)} ${r.sqliteVersion.padEnd(8)} ${objs.padEnd(32)} ${String(r.viewsExecuted).padStart(9)}  ${String(r.julianday)}`,
    );
  }

  console.log('\nloading the 23 MiB prebuilt database into the engine');
  for (const r of reports) {
    console.log(`${r.label.padEnd(26)} ${r.loadMs.toFixed(1)} ms`);
  }

  console.log('\nquery timings — best of ' + String(RUNS) + ', warm, one desktop machine');
  console.log('query   rows     hash      ' + reports.map((r) => r.label.padStart(24)).join(''));
  let disagreements = 0;
  for (const q of CANONICAL_QUERIES) {
    const first = reports[0]?.timings.get(q.id);
    if (first === undefined) continue;
    const cells = reports.map((r) => {
      const t = r.timings.get(q.id);
      if (t === undefined) return 'missing'.padStart(24);
      const agree = t.rows === first.rows && t.hash === first.hash;
      if (!agree) disagreements++;
      return `${t.bestMs.toFixed(1)} ms${agree ? '' : ' MISMATCH'}`.padStart(24);
    });
    console.log(
      `${q.id.padEnd(7)} ${String(first.rows).padStart(6)}   ${first.hash}  ${cells.join('')}`,
    );
  }

  const WASM_DIST = dirname(require.resolve('@sqlite.org/sqlite-wasm'));
  const payloads: readonly (readonly [string, readonly string[]])[] = [
    ['@sqlite.org/sqlite-wasm', [join(WASM_DIST, 'index.mjs'), join(WASM_DIST, 'sqlite3.wasm')]],
    ['sql.js', [join(SQL_JS_DIST, 'sql-wasm.js'), join(SQL_JS_DIST, 'sql-wasm.wasm')]],
  ];
  console.log('\nengine payload the browser downloads (measured on the installed tarball)');
  for (const [name, files] of payloads) {
    const p = payload(files);
    const kb = (n: number): string => `${(n / 1024).toFixed(0)} KB`;
    console.log(
      `${name.padEnd(26)} raw ${kb(p.raw).padStart(8)}  gzip-9 ${kb(p.gzip).padStart(8)}  brotli-11 ${kb(p.brotli).padStart(8)}`,
    );
  }

  console.log(
    `\nresult-set agreement across engines: ${disagreements === 0 ? 'identical rows and identical values on every query' : `${String(disagreements)} DISAGREEMENTS`}`,
  );
}

await main();
