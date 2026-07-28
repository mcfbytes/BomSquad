import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { openFixtureDatabase } from '../../testing/fixture-database';
import { VIEW_NAMES } from './view-types.generated';

/**
 * The other half of the view-type story.
 *
 * `generate-db-types.mjs` guarantees that `site/tools/view-column-types.mjs` lists
 * exactly the columns each view has, in the order the DDL declares them. That is a
 * structural check, and it runs in the build. What it cannot check is whether the
 * declared *types* are true, because SQLite records no type metadata for a view.
 *
 * So this asserts them against data: every view in the fixture database is read and
 * each value's SQLite storage class is compared with what the declaration promised.
 * A column declared `string` that comes back an integer, or one declared
 * non-nullable that comes back NULL, fails here.
 *
 * The generated file is *parsed* rather than imported on purpose. Types are erased
 * at runtime; asserting against a value derived from the type would prove nothing.
 */

const SITE_ROOT = process.cwd();
const REPO_ROOT = resolve(SITE_ROOT, '..');

const DECLARED = readFileSync(join(SITE_ROOT, 'tools/view-column-types.mjs'), 'utf8');
const GENERATED = readFileSync(join(SITE_ROOT, 'src/app/data/view-types.generated.ts'), 'utf8');

type StorageClass = 'text' | 'integer' | 'real';

interface DeclaredColumn {
  readonly name: string;
  readonly nullable: boolean;
  readonly storage: readonly StorageClass[];
}

const TYPE_ALIASES = new Map(
  [...GENERATED.matchAll(/^export type (\w+) =\s*([^;]+);$/gm)].map((match) => [
    match[1] ?? '',
    (match[2] ?? '').replaceAll(/\s+/g, ' ').trim(),
  ]),
);

function interfaceName(view: string): string {
  return `${view
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')}Row`;
}

function declaredColumns(view: string): readonly DeclaredColumn[] {
  const pattern = new RegExp(`export interface ${interfaceName(view)} \\{([\\s\\S]*?)\\n\\}`);
  const body = pattern.exec(GENERATED)?.[1];
  expect(body, `no generated interface for ${view}`).toBeDefined();

  return [...(body ?? '').matchAll(/readonly (\w+): (.+);/g)].map((match) => {
    let type = match[2] ?? '';
    for (const [alias, expansion] of TYPE_ALIASES) {
      type = type.replaceAll(new RegExp(`\\b${alias}\\b`, 'g'), expansion);
    }

    const storage: StorageClass[] = [];
    if (type.includes("'") || /\bstring\b/.test(type)) {
      storage.push('text');
    }
    if (/\bnumber\b/.test(type) || /(^|[\s|(])\d/.test(type)) {
      storage.push('integer', 'real');
    }

    return { name: match[1] ?? '', nullable: /\bnull\b/.test(type), storage };
  });
}

describe('declared view column types', () => {
  const db = openFixtureDatabase();

  it.each([...VIEW_NAMES])('describe %s exactly, on every fixture row', (view) => {
    const columns = declaredColumns(view);

    expect(columns.map((column) => column.name)).toEqual(
      db
        .prepare(`SELECT * FROM "${view}"`)
        .columns()
        .map((column) => column.name),
    );

    const projection = columns
      .map((column) => `typeof("${column.name}") AS "${column.name}"`)
      .join(', ');
    const rows = db.prepare(`SELECT ${projection} FROM "${view}"`).all();

    for (const row of rows) {
      for (const column of columns) {
        const storage = String(row[column.name]);
        if (storage === 'null') {
          expect(column.nullable, `${view}.${column.name} came back NULL`).toBe(true);
        } else {
          expect(column.storage, `${view}.${column.name} came back ${storage}`).toContain(storage);
        }
      }
    }
  });

  it('actually produces NULLs, so the nullable declarations are tested and not assumed', () => {
    // Without this, every `| null` above would pass vacuously on an over-tidy
    // fixture. These three are the ones the fixture is deliberately shaped for:
    // a machine in no system with an unparseable MAME year, and a chip in a
    // system's BOM that no implementation of that kind can satisfy.
    const machines = db
      .prepare(
        `SELECT COUNT(*) AS n FROM v_machine
          WHERE system_id IS NULL AND year IS NULL AND clone_count IS NULL`,
      )
      .get();
    const unsatisfied = db
      .prepare(`SELECT COUNT(*) AS n FROM v_system_chip_coverage WHERE provider_chip_id IS NULL`)
      .get();

    expect(Number(machines?.['n'])).toBeGreaterThan(0);
    expect(Number(unsatisfied?.['n'])).toBeGreaterThan(0);
  });

  it('covers every view the schema ships', () => {
    const inFixture = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name`)
      .all()
      .map((row) => String(row['name']));

    expect([...VIEW_NAMES]).toEqual(inFixture);
  });
});

describe('the quality warning registry', () => {
  it('matches the codes v_quality_warning actually emits', () => {
    // `QualityWarningCode` is the one union that cannot be derived from an empty
    // schema — the codes are SQL string literals inside the view, so a schema-only
    // database yields none of them. It is hand-listed; this re-derives it from the
    // view's own DDL and fails if the two have parted company.
    const schema = readFileSync(join(REPO_ROOT, 'schemas/schema.sql'), 'utf8');
    const definition = /CREATE VIEW v_quality_warning AS([\s\S]*?);\s*$/.exec(schema)?.[1] ?? '';
    const fromDdl = [...definition.matchAll(/SELECT\s+'([A-Z][A-Z0-9_]*)'/g)].map(
      (match) => match[1],
    );

    const declared = /QualityWarningCode: \[([\s\S]*?)\]\.join/.exec(DECLARED)?.[1] ?? '';
    const fromDeclaration = [...declared.matchAll(/"'([A-Z][A-Z0-9_]*)'"/g)].map(
      (match) => match[1],
    );

    expect(fromDdl).toHaveLength(15);
    expect(fromDeclaration).toEqual(fromDdl);
  });
});
