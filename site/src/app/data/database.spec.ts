import { TestBed } from '@angular/core/testing';

import {
  indexHtmlResponse,
  notFoundResponse,
  provideFixtureDatabase,
} from '../../testing/database-testing';
import { fixtureDatabaseBytes } from '../../testing/fixture-database';
import { DatabaseService } from './database';
import type { ChipRow } from './schema-types.generated';
import { DatabaseLoadError, SqlQueryError } from './sql';
import type { VProspectorRow } from './view-types.generated';

/**
 * T7.2 against a real fixture **database** — `schemas/schema.sql` applied whole to
 * a real SQLite file, opened through the real `@sqlite.org/sqlite-wasm` by the real
 * `sqlite3_deserialize` path. Only `fetch` is substituted.
 *
 * The failure cases matter as much as the happy one: ADR 0001 makes the entire data
 * layer depend on a single request, so "a failed database fetch … surfaces a
 * user-visible error state, not a blank page" is the acceptance criterion with the
 * most surface area.
 */

function setUp(options: Parameters<typeof provideFixtureDatabase>[0] = {}) {
  const fixture = provideFixtureDatabase(options);
  TestBed.configureTestingModule({ providers: fixture.providers });
  return { log: fixture.log, database: TestBed.inject(DatabaseService) };
}

describe('DatabaseService', () => {
  it('starts idle and asks for nothing', () => {
    const { database, log } = setUp();

    expect(database.status()).toBe('idle');
    expect(database.error()).toBeNull();
    expect(log.calls).toEqual([]);
  });

  it('downloads once and opens the database', async () => {
    const { database, log } = setUp();

    await database.ensureLoaded();

    expect(database.status()).toBe('ready');
    expect(database.isReady()).toBe(true);
    expect(log.calls).toEqual(['/site-data/bomsquad.sqlite']);
    expect(database.loadDurationMs()).toBeGreaterThanOrEqual(0);
  });

  it('reports how much of the download has arrived', async () => {
    const { database } = setUp();

    await database.ensureLoaded();

    expect(database.progress()?.receivedBytes).toBe(fixtureDatabaseBytes().byteLength);
    expect(database.progress()?.totalBytes).toBe(fixtureDatabaseBytes().byteLength);
    expect(database.progressFraction()).toBe(1);
  });

  it('shares one in-flight download between concurrent callers', async () => {
    const { database, log } = setUp();

    await Promise.all([
      database.ensureLoaded(),
      database.ensureLoaded(),
      database.select('SELECT 1'),
    ]);

    expect(log.calls).toHaveLength(1);
  });

  it('queries tables with the generated row types', async () => {
    const { database } = setUp();

    const chips = await database.select<ChipRow>(
      'SELECT * FROM chip WHERE function_id = :function ORDER BY chip_id',
      { ':function': 'cpu' },
    );

    expect(chips.map((chip) => chip.chip_id)).toEqual(['m68000', 'z80', 'z80a']);
    expect(chips[0]?.display_name).toBe('M68000');
    expect(chips[0]?.family_id).toBeNull();
  });

  it('queries the shipped views', async () => {
    const { database } = setUp();

    const rows = await database.select<VProspectorRow>(
      'SELECT * FROM v_prospector WHERE platform_id = :platform ORDER BY system_id',
      { ':platform': 'mister' },
    );

    expect(rows.map((row) => row.system_id)).toEqual(['capcom-cps1', 'sega-system1']);
    expect(rows[0]?.satisfied_share).toBeCloseTo(0.75, 5);
    expect(rows[1]?.chips_equivalent).toBe(1);
  });

  it('reads a single scalar', async () => {
    const { database } = setUp();

    await expect(
      database.selectValue<number>('SELECT COUNT(*) AS value FROM machine'),
    ).resolves.toBe(3);
  });

  it('opens the database read-only, so a stray write cannot corrupt the copy', async () => {
    const { database } = setUp();

    await expect(database.select("DELETE FROM chip WHERE chip_id = 'z80'")).rejects.toThrow(
      /readonly/i,
    );
  });
});

describe('when the one fetch that can fail, fails', () => {
  it('turns a 404 into an actionable deployment message', async () => {
    const { database } = setUp({ respondWith: notFoundResponse });

    await expect(database.ensureLoaded()).rejects.toBeInstanceOf(DatabaseLoadError);

    const error = database.error();
    expect(database.status()).toBe('error');
    expect(error?.kind).toBe('http');
    expect(error?.message).toContain('404');
  });

  it('names the missing deploy step when the SPA fallback serves index.html instead', async () => {
    // The failure mode ADR 0001's `navigationFallback.exclude` rule exists to
    // prevent: a 200 full of HTML, which SQLite would otherwise reject somewhere
    // deep in wasm with "file is not a database".
    const { database } = setUp({ respondWith: indexHtmlResponse });

    await expect(database.ensureLoaded()).rejects.toBeInstanceOf(DatabaseLoadError);

    expect(database.error()?.kind).toBe('http');
    expect(database.error()?.message).toContain('dist/bomsquad.sqlite');
  });

  it('distinguishes an unreachable server from a bad one', async () => {
    const { database } = setUp({ rejectWith: new TypeError('Failed to fetch') });

    await expect(database.ensureLoaded()).rejects.toBeInstanceOf(DatabaseLoadError);

    expect(database.error()?.kind).toBe('network');
    expect(database.error()?.message).toContain('Failed to fetch');
  });

  it('leaves the failure on the signals rather than throwing into the void', async () => {
    const { database } = setUp({ respondWith: notFoundResponse });

    await database.ensureLoaded().catch(() => undefined);

    expect(database.status()).toBe('error');
    expect(database.error()).not.toBeNull();
    expect(database.isReady()).toBe(false);
  });

  it('retries on demand and succeeds when the server comes back', async () => {
    let broken = true;
    const { database, log } = setUp({
      respondWith: () => (broken ? notFoundResponse() : fixtureOkResponse()),
    });

    await database.ensureLoaded().catch(() => undefined);
    expect(database.status()).toBe('error');

    broken = false;
    database.retry();
    await database.ensureLoaded();

    expect(database.status()).toBe('ready');
    expect(log.calls).toHaveLength(2);
  });
});

describe('a query the engine refuses', () => {
  it('surfaces SQLite’s own message for a view that is not in the schema', async () => {
    const { database } = setUp();

    await expect(database.select('SELECT * FROM v_does_not_exist')).rejects.toBeInstanceOf(
      SqlQueryError,
    );
    await expect(database.select('SELECT * FROM v_does_not_exist')).rejects.toThrow(
      /no such table: v_does_not_exist/,
    );
  });

  it('carries the offending statement, so a bug report can quote it', async () => {
    const { database } = setUp();

    const error = await database.select('SELECT nope FROM chip').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SqlQueryError);
    expect((error as SqlQueryError).sql).toBe('SELECT nope FROM chip');
  });

  it('does not poison the connection — the next query still works', async () => {
    const { database } = setUp();

    await database.select('SELECT * FROM v_does_not_exist').catch(() => undefined);

    await expect(database.selectValue<number>('SELECT COUNT(*) AS value FROM chip')).resolves.toBe(
      5,
    );
  });
});

function fixtureOkResponse(): Response {
  const bytes = fixtureDatabaseBytes();
  return new Response(bytes.slice().buffer, {
    status: 200,
    headers: { 'content-length': String(bytes.byteLength) },
  });
}
