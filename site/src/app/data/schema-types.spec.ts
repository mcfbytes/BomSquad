import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { TABLE_NAMES } from './schema-types.generated';
import { VIEW_NAMES } from './view-types.generated';

/**
 * T7.2's first acceptance criterion is "types are codegen'd in the build". The
 * generated files are committed — so `npx ng build` works in a fresh clone without
 * a preceding codegen step — which means the only thing that can go wrong is drift,
 * and drift is what this file exists to catch.
 *
 * The generator itself performs the cross-checks that matter (property names and
 * order against the DDL, `required` against `NOT NULL`, JSON type against declared
 * SQLite type, view columns against `view-column-types.mjs`) and exits non-zero on
 * any of them. Running it in `--check` mode here means a change to `schemas/`
 * without a regeneration fails the suite instead of shipping stale types.
 */

const SITE_ROOT = process.cwd();
const REPO_ROOT = resolve(SITE_ROOT, '..');

function schemaObjects(type: 'table' | 'view'): readonly string[] {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(readFileSync(join(REPO_ROOT, 'schemas/schema.sql'), 'utf8'));
    return db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all(type)
      .map((row) => String(row['name']));
  } finally {
    db.close();
  }
}

describe('generated row types', () => {
  it('are up to date with schemas/', () => {
    const result = spawnSync(process.execPath, ['tools/generate-db-types.mjs', '--check'], {
      cwd: SITE_ROOT,
      encoding: 'utf8',
    });

    expect(`${result.stdout}${result.stderr}`.trim()).toBe('');
    expect(result.status).toBe(0);
  });

  it('cover every table in schemas/schema.sql', () => {
    expect([...TABLE_NAMES]).toEqual([...schemaObjects('table')]);
  });

  it('cover every view in schemas/schema.sql', () => {
    expect([...VIEW_NAMES]).toEqual([...schemaObjects('view')]);
  });

  it('match the counts ADR 0001 states the schema has', () => {
    expect(TABLE_NAMES).toHaveLength(36);
    expect(VIEW_NAMES).toHaveLength(21);
  });

  it('are not hand-editable without the suite noticing', () => {
    for (const file of ['schema-types.generated.ts', 'view-types.generated.ts']) {
      const source = readFileSync(join(SITE_ROOT, 'src/app/data', file), 'utf8');
      expect(source).toContain('GENERATED FILE — DO NOT EDIT');
      expect(source).toContain('site/tools/generate-db-types.mjs');
    }
  });
});

describe('the JSON Schemas stay the source of truth', () => {
  it('leaves exactly one table typed outside them, and says which', () => {
    // `threshold` is written by the loader from pipeline/config, not from a curated
    // row file, so it has no row-file schema. If a second table ever joins it, the
    // generator's own coverage check fires — this asserts the exception has not
    // quietly grown into a habit.
    const declared = readFileSync(join(SITE_ROOT, 'tools/view-column-types.mjs'), 'utf8');
    const extras = /export const EXTRA_TABLE_TYPES = \{([\s\S]*?)\n\};/.exec(declared)?.[1] ?? '';
    const names = [...extras.matchAll(/^ {2}(\w+): \{/gm)].map((match) => match[1]);

    expect(names).toEqual(['threshold']);
  });
});
