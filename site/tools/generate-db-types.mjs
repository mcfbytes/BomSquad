/**
 * Generates the data layer's row types (T7.2).
 *
 *   node site/tools/generate-db-types.mjs [--check]
 *
 * Two outputs, two sources, one rule each:
 *
 * | file                                       | comes from                                       |
 * | ------------------------------------------ | ------------------------------------------------ |
 * | `src/app/data/schema-types.generated.ts`   | `schemas/*.schema.json`, cross-checked vs the DDL |
 * | `src/app/data/view-types.generated.ts`     | the DDL's view columns + `view-column-types.mjs`  |
 *
 * The JSON Schemas are the single source of truth for table rows — TASKS.md T7.2
 * says so explicitly, and hand-written row interfaces on a 36-table schema drift
 * within a release. Everything the generator cannot read out of them it refuses to
 * guess: an unknown `$ref`, a view column with no declared type, a table with
 * neither a schema nor an entry in `EXTRA_TABLE_TYPES` all fail the run.
 *
 * It also cross-checks the two sources against each other, because a JSON Schema
 * that has quietly stopped describing its table is worse than no schema at all:
 *
 *  1. every table in `schemas/schema.sql` is accounted for;
 *  2. each schema's property names and order equal the table's columns exactly;
 *  3. each property's JSON type family matches the column's declared SQLite type;
 *  4. every `required` property is `NOT NULL` in the DDL;
 *  5. every `NOT NULL` column without a `DEFAULT` is `required` in the schema —
 *     a defaulted column may be omitted from a row *file* and still be NOT NULL in
 *     the *database*, which is why nullability below is read off the DDL, not off
 *     `required`;
 *  6. every view lists exactly the columns the DDL gives it, in order.
 *
 * `--check` regenerates into memory and diffs against what is on disk, exiting
 * non-zero on any difference. `schema-types.spec.ts` runs that, so a schema change
 * without a regeneration fails the test suite rather than shipping stale types.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import prettier from 'prettier';

import { EXTRA_TABLE_TYPES, VIEW_COLUMN_TYPES, VIEW_TYPE_ALIASES } from './view-column-types.mjs';

const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(SITE_ROOT, '..');
const SCHEMA_DIR = join(REPO_ROOT, 'schemas');
const OUT_DIR = join(SITE_ROOT, 'src/app/data');

/** JSON Schema files that describe something other than one table. */
const NON_TABLE_SCHEMAS = new Set(['common', 'rowfile', 'quality-report']);

/**
 * `common.schema.json`'s `$defs`, mapped to TypeScript. Every one of these mirrors
 * a CHECK constraint, so the TS side is only ever as precise as a scalar: the
 * grammars are enforced by the database, not by the compiler.
 */
const SCALAR_BY_DEF = {
  slug: 'string',
  identifier: 'string',
  spdxId: 'string',
  mameShortname: 'string',
  mameDeviceKey: 'string',
  mameTag: 'string',
  sourcefile: 'string',
  repoPath: 'string',
  isoDate: 'string',
  url: 'string',
  text: 'string',
  metaKey: 'string',
  countryCode: 'string',
  semver: 'string',
  // SQLite under STRICT has no boolean; the CHECK is `IN (0, 1)`.
  flag: '0 | 1',
  positiveInt: 'number',
  year: 'number',
};

/** Which SQLite storage classes a JSON Schema type is allowed to sit on. */
const SQLITE_TYPES_BY_JSON_TYPE = {
  string: ['TEXT'],
  integer: ['INTEGER'],
  number: ['REAL', 'INTEGER'],
};

class GeneratorError extends Error {}

function fail(message) {
  throw new GeneratorError(message);
}

// --- reading the DDL ----------------------------------------------------------

/**
 * Applies `schemas/schema.sql` to an empty in-memory database and reads the shape
 * back out of it.
 *
 * Parsing the DDL with a regular expression would be a second, worse SQLite; this
 * asks the real one. It also means the generator fails loudly if the shipped DDL
 * stops being valid SQL, which is a check worth having for free.
 */
function readDdl() {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(readFileSync(join(SCHEMA_DIR, 'schema.sql'), 'utf8'));

    const objects = db
      .prepare(
        `SELECT type, name FROM sqlite_master
          WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
          ORDER BY name`,
      )
      .all();

    const tables = new Map();
    const views = new Map();

    for (const { type, name } of objects) {
      if (type === 'table') {
        tables.set(
          name,
          db
            .prepare(`PRAGMA table_info(${quoteIdent(name)})`)
            .all()
            .map((column) => ({
              name: column.name,
              type: String(column.type).toUpperCase(),
              notNull: column.notnull === 1 || column.pk === 1,
              hasDefault: column.dflt_value !== null,
            })),
        );
      } else {
        views.set(
          name,
          db
            .prepare(`SELECT * FROM ${quoteIdent(name)}`)
            .columns()
            .map((column) => column.name),
        );
      }
    }

    return { tables, views };
  } finally {
    db.close();
  }
}

function quoteIdent(name) {
  return `"${name.replaceAll('"', '""')}"`;
}

// --- reading the JSON Schemas -------------------------------------------------

function readTableSchemas() {
  const schemas = new Map();
  for (const file of readdirSync(SCHEMA_DIR).sort()) {
    if (!file.endsWith('.schema.json')) {
      continue;
    }
    const name = file.slice(0, -'.schema.json'.length);
    if (NON_TABLE_SCHEMAS.has(name)) {
      continue;
    }
    schemas.set(name, JSON.parse(readFileSync(join(SCHEMA_DIR, file), 'utf8')));
  }
  return schemas;
}

/**
 * One JSON Schema property to a TypeScript type, plus the JSON type family used to
 * cross-check it against the column's declared SQLite type.
 */
function propertyType(table, property, definition) {
  const ref = definition.$ref;
  if (typeof ref === 'string') {
    const match = /^common\.schema\.json#\/\$defs\/(?<def>\w+)$/.exec(ref);
    const def = match?.groups?.def;
    if (def === undefined || !Object.hasOwn(SCALAR_BY_DEF, def)) {
      fail(`${table}.${property}: unsupported $ref "${ref}" — add it to SCALAR_BY_DEF.`);
    }
    const type = SCALAR_BY_DEF[def];
    return { type, jsonType: type === 'string' ? 'string' : 'integer' };
  }

  if (Array.isArray(definition.enum)) {
    if (definition.type !== 'string' || definition.enum.some((v) => typeof v !== 'string')) {
      fail(`${table}.${property}: only string enums are supported.`);
    }
    return {
      type: definition.enum.map((value) => `'${value}'`).join(' | '),
      jsonType: 'string',
    };
  }

  fail(
    `${table}.${property}: neither a common.schema.json $ref nor a string enum. ` +
      'The JSON Schemas are the source of truth for row types, so this has to be expressible there.',
  );
}

// --- cross-checks -------------------------------------------------------------

function crossCheckTable(table, schema, columns) {
  const declared = Object.keys(schema.properties ?? {});
  const actual = columns.map((column) => column.name);

  if (declared.join(',') !== actual.join(',')) {
    fail(
      `${table}: schemas/${table}.schema.json properties do not match schemas/schema.sql.\n` +
        `  schema.json: ${declared.join(', ')}\n` +
        `  schema.sql:  ${actual.join(', ')}`,
    );
  }

  const required = new Set(schema.required ?? []);
  for (const column of columns) {
    if (required.has(column.name) && !column.notNull) {
      fail(`${table}.${column.name}: required in the JSON Schema but nullable in the DDL.`);
    }
    if (column.notNull && !column.hasDefault && !required.has(column.name)) {
      fail(
        `${table}.${column.name}: NOT NULL with no DEFAULT in the DDL but not required in the ` +
          'JSON Schema — a curator could write a row file the loader cannot insert.',
      );
    }
  }
}

function crossCheckScalar(table, column, jsonType) {
  const allowed = SQLITE_TYPES_BY_JSON_TYPE[jsonType] ?? [];
  if (!allowed.includes(column.type)) {
    fail(`${table}.${column.name}: JSON Schema says ${jsonType} but the column is ${column.type}.`);
  }
}

// --- emitting -----------------------------------------------------------------

function interfaceName(relation) {
  return `${relation
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')}Row`;
}

const BANNER = (source) =>
  `/* GENERATED FILE — DO NOT EDIT.
 *
 * Written by site/tools/generate-db-types.mjs from ${source}.
 * Regenerate with \`npm run codegen --workspace @bomsquad/site\`;
 * schema-types.spec.ts fails the suite if this file and its source disagree.
 */
`;

function emitTableTypes({ tables }, schemas) {
  const names = [...schemas.keys()].sort();
  const extras = Object.keys(EXTRA_TABLE_TYPES).sort();
  const all = [...names, ...extras].sort();

  const missing = [...tables.keys()].filter((table) => !all.includes(table));
  if (missing.length > 0) {
    fail(
      `Tables in schemas/schema.sql with no JSON Schema and no EXTRA_TABLE_TYPES entry: ` +
        `${missing.join(', ')}.`,
    );
  }
  const unknown = all.filter((table) => !tables.has(table));
  if (unknown.length > 0) {
    fail(
      `Row types declared for tables that schemas/schema.sql does not have: ${unknown.join(', ')}.`,
    );
  }

  const blocks = [];

  for (const table of all) {
    const columns = tables.get(table);
    const schema = schemas.get(table);
    const fields = [];

    if (schema === undefined) {
      const declared = EXTRA_TABLE_TYPES[table];
      const declaredNames = Object.keys(declared);
      if (declaredNames.join(',') !== columns.map((c) => c.name).join(',')) {
        fail(
          `${table}: EXTRA_TABLE_TYPES columns do not match schemas/schema.sql.\n` +
            `  declared:   ${declaredNames.join(', ')}\n` +
            `  schema.sql: ${columns.map((c) => c.name).join(', ')}`,
        );
      }
      for (const column of columns) {
        fields.push(`  readonly ${column.name}: ${nullable(declared[column.name], column)};`);
      }
    } else {
      crossCheckTable(table, schema, columns);
      for (const column of columns) {
        const { type, jsonType } = propertyType(table, column.name, schema.properties[column.name]);
        crossCheckScalar(table, column, jsonType);
        fields.push(`  readonly ${column.name}: ${nullable(type, column)};`);
      }
    }

    const description =
      typeof schema?.description === 'string'
        ? schema.description.split(';')[0].trim()
        : `One row of the \`${table}\` table`;

    blocks.push(
      `/** ${description}. */\nexport interface ${interfaceName(table)} {\n${fields.join('\n')}\n}`,
    );
  }

  const map = all.map((table) => `  readonly ${table}: ${interfaceName(table)};`).join('\n');
  const list = all.map((table) => `  '${table}',`).join('\n');

  return [
    BANNER('schemas/*.schema.json, cross-checked against schemas/schema.sql'),
    '',
    '/*',
    ' * A row as the *database* returns it, which is not quite a row as a curated row',
    ' * file writes it: data-model.md §4.3 omits a NULL column rather than writing',
    ' * `null`, so a JSON-Schema-optional property is `T | null` here. Nullability is',
    ' * therefore read off the DDL, never off `required` — `machine_chip.quantity` is',
    ' * omissible in a row file (it defaults to 1) and still NOT NULL in the table.',
    ' */',
    '',
    blocks.join('\n\n'),
    '',
    '/** Every table in `schemas/schema.sql`, keyed by name. */',
    `export interface TableRowTypes {\n${map}\n}`,
    '',
    'export type TableName = keyof TableRowTypes;',
    '',
    '/** Sorted, so the list is stable across regenerations. */',
    `export const TABLE_NAMES: readonly TableName[] = [\n${list}\n];`,
    '',
  ].join('\n');
}

function nullable(type, column) {
  if (column.notNull) {
    return type;
  }
  return type.includes('|') ? `(${type}) | null` : `${type} | null`;
}

function emitViewTypes({ views }) {
  const declaredViews = Object.keys(VIEW_COLUMN_TYPES);

  const missing = [...views.keys()].filter((view) => !declaredViews.includes(view));
  if (missing.length > 0) {
    fail(
      `Views in schemas/schema.sql with no entry in site/tools/view-column-types.mjs: ` +
        `${missing.join(', ')}.`,
    );
  }
  const unknown = declaredViews.filter((view) => !views.has(view));
  if (unknown.length > 0) {
    fail(`view-column-types.mjs declares views that do not exist: ${unknown.join(', ')}.`);
  }

  for (const [view, columns] of views) {
    const declared = Object.keys(VIEW_COLUMN_TYPES[view]);
    if (declared.join(',') !== columns.join(',')) {
      fail(
        `${view}: view-column-types.mjs columns do not match schemas/schema.sql.\n` +
          `  declared:   ${declared.join(', ')}\n` +
          `  schema.sql: ${columns.join(', ')}`,
      );
    }
  }

  const names = [...views.keys()].sort();

  const aliases = Object.entries(VIEW_TYPE_ALIASES)
    .map(([name, type]) => `export type ${name} = ${type};`)
    .join('\n');

  const blocks = names.map((view) => {
    const fields = views
      .get(view)
      .map((column) => `  readonly ${column}: ${VIEW_COLUMN_TYPES[view][column]};`)
      .join('\n');
    return `/** One row of the \`${view}\` view. */\nexport interface ${interfaceName(view)} {\n${fields}\n}`;
  });

  const map = names.map((view) => `  readonly ${view}: ${interfaceName(view)};`).join('\n');
  const list = names.map((view) => `  '${view}',`).join('\n');

  return [
    BANNER(
      'schemas/schema.sql (column names and order) + site/tools/view-column-types.mjs (types)',
    ),
    '',
    '/*',
    ' * Views are the stable query surface (schemas/README.md), but SQLite records no',
    ' * usable type metadata for them, so the column *types* below are declared in',
    ' * site/tools/view-column-types.mjs and the column *names and order* come from',
    ' * the DDL. The generator refuses to run if the two disagree.',
    ' */',
    '',
    aliases,
    '',
    blocks.join('\n\n'),
    '',
    '/** Every view in `schemas/schema.sql`, keyed by name. */',
    `export interface ViewRowTypes {\n${map}\n}`,
    '',
    'export type ViewName = keyof ViewRowTypes;',
    '',
    '/** Sorted, so the list is stable across regenerations. */',
    `export const VIEW_NAMES: readonly ViewName[] = [\n${list}\n];`,
    '',
  ].join('\n');
}

// --- entry point ---------------------------------------------------------------

/**
 * @returns {Promise<Map<string, string>>} absolute path -> file contents, already
 * run through the repository's Prettier config so `prettier --check` passes on the
 * generated files and `--check`'s diff is not a formatting artefact.
 */
export async function generate() {
  const ddl = readDdl();
  const schemas = readTableSchemas();
  const options = { ...(await prettier.resolveConfig(OUT_DIR)), parser: 'typescript' };

  const files = new Map();
  for (const [file, source] of [
    ['schema-types.generated.ts', emitTableTypes(ddl, schemas)],
    ['view-types.generated.ts', emitViewTypes(ddl)],
  ]) {
    files.set(join(OUT_DIR, file), await prettier.format(source, options));
  }
  return files;
}

async function main(argv) {
  const check = argv.includes('--check');
  let files;
  try {
    files = await generate();
  } catch (error) {
    if (error instanceof GeneratorError) {
      process.stderr.write(`generate-db-types: ${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const stale = [];
  for (const [path, contents] of files) {
    const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
    if (current === contents) {
      continue;
    }
    if (check) {
      stale.push(path);
    } else {
      writeFileSync(path, contents);
      process.stdout.write(`generate-db-types: wrote ${path}\n`);
    }
  }

  if (stale.length > 0) {
    process.stderr.write(
      `generate-db-types: out of date:\n${stale.map((p) => `  ${p}`).join('\n')}\n` +
        'Run `npm run codegen --workspace @bomsquad/site`.\n',
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  await main(process.argv.slice(2));
}
