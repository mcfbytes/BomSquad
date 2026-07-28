/**
 * TASKS T6.4 — `dist/quality-report.json`, the flat scalar summary (data-quality.md §8).
 *
 * **Every scalar traces to a query against a shipped view, never to a re-derivation.**
 * `instances` is `v_quality_instance` with the share rounded *by SQL*, `devices` is
 * `v_quality_device`, `warnings_by_code` is a `GROUP BY` over `v_quality_warning`. The
 * arithmetic is the database's, so the number in the file and the number the site renders
 * from the same view cannot drift, and re-rounding in JavaScript cannot introduce a
 * half-even/half-up disagreement with SQLite's `ROUND`.
 *
 * `counts` is the one member with no view behind it, and deliberately so: §8 defines it as
 * "one `COUNT(*)` per top-level curated entity", a count of a base table. Counting
 * `v_machine` instead would silently change meaning the day a view grew a join that
 * multiplied rows.
 *
 * Two rules the shape enforces:
 *
 * - **Nothing that is a list.** §8's whole argument is that the database ships anyway and
 *   answers `WHERE code = … ORDER BY impact DESC` without a truncation protocol. The one
 *   map here, `warnings_by_code`, is bounded by the closed code registry.
 * - **No timestamps, no wall-clock, no host paths.** `dataset_version`, `mame_version`,
 *   `schema_version` and `threshold_version` are copied verbatim out of `dataset_meta`,
 *   whose `build_date` is itself an input to the build, not a reading of the clock.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

import type { DatabaseSync } from 'node:sqlite';

import { SCHEMAS_DIR } from '../db/schema.js';
import { compareBytes } from '../db/rowfiles.js';

/** See `validate/index.ts`: `ajv-formats` declares a default export but assigns `module.exports`. */
const addFormats = addFormatsModule as unknown as (typeof addFormatsModule)['default'];

export const QUALITY_REPORT_FILE = 'quality-report.json';

/** `dist/quality-report.json`, exactly as data-quality.md §8 specifies it. */
export interface QualityReport {
  readonly counts: {
    readonly chip: number;
    readonly implementation: number;
    readonly machine: number;
    readonly project: number;
    readonly system: number;
  };
  readonly dataset_version: string;
  readonly db_bytes: number;
  readonly devices: {
    readonly ignored: number;
    readonly mapped: number;
    readonly unmapped: number;
  };
  readonly instances: {
    readonly mapped: number;
    readonly mapped_instance_share: number;
    readonly total: number;
    readonly unmapped: number;
  };
  readonly mame_version: string;
  readonly schema_version: string;
  readonly threshold_version: string;
  readonly warnings_by_code: Readonly<Record<string, number>>;
}

/** The five top-level curated entities §8 counts. Bytewise, which is also the key order. */
const COUNTED_TABLES = ['chip', 'implementation', 'machine', 'project', 'system'] as const;

function integer(value: unknown, where: string): number {
  const numeric = typeof value === 'bigint' ? Number(value) : value;
  if (typeof numeric !== 'number' || !Number.isFinite(numeric)) {
    throw new Error(`${where}: expected a number, received ${typeof value}`);
  }
  return numeric;
}

function metaValue(db: DatabaseSync, key: string): string {
  const row = db.prepare('SELECT value FROM dataset_meta WHERE key = ?').get(key);
  const value = row?.['value'];
  if (typeof value !== 'string') {
    throw new Error(
      `dataset_meta.${key} is missing; DATASET_META_INCOMPLETE (data-quality.md §3.7) should have caught this`,
    );
  }
  return value;
}

/**
 * Reads every scalar off the finished database.
 *
 * `db_bytes` is the caller's, because it is a fact about the file rather than about its
 * contents and is only true after `VACUUM` has finished writing it.
 */
export function collectQualityReport(db: DatabaseSync, dbBytes: number): QualityReport {
  const counts: Record<string, number> = {};
  for (const table of COUNTED_TABLES) {
    counts[table] = integer(
      db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get()?.['n'],
      `COUNT(*) FROM ${table}`,
    );
  }

  const devices = db
    .prepare('SELECT devices_ignored, devices_mapped, devices_unmapped FROM v_quality_device')
    .get();
  // ROUND in SQL, per §8: the file's number is the database's, not JavaScript's.
  const instances = db
    .prepare(
      `SELECT mapped_instances, unmapped_instances, total_instances,
              ROUND(mapped_instance_share, 4) AS mapped_instance_share
       FROM v_quality_instance`,
    )
    .get();

  const warnings: Record<string, number> = {};
  for (const row of db
    .prepare('SELECT code, COUNT(*) AS n FROM v_quality_warning GROUP BY code ORDER BY code')
    .all()) {
    // Codes with zero rows never appear here at all — §8 omits them, and a consumer
    // treats a missing key as zero.
    warnings[String(row['code'])] = integer(row['n'], 'v_quality_warning count');
  }

  return {
    counts: {
      chip: counts['chip'] ?? 0,
      implementation: counts['implementation'] ?? 0,
      machine: counts['machine'] ?? 0,
      project: counts['project'] ?? 0,
      system: counts['system'] ?? 0,
    },
    dataset_version: metaValue(db, 'dataset_version'),
    db_bytes: dbBytes,
    devices: {
      ignored: integer(devices?.['devices_ignored'], 'v_quality_device.devices_ignored'),
      mapped: integer(devices?.['devices_mapped'], 'v_quality_device.devices_mapped'),
      unmapped: integer(devices?.['devices_unmapped'], 'v_quality_device.devices_unmapped'),
    },
    instances: {
      mapped: integer(instances?.['mapped_instances'], 'v_quality_instance.mapped_instances'),
      mapped_instance_share: integer(
        instances?.['mapped_instance_share'],
        'v_quality_instance.mapped_instance_share',
      ),
      total: integer(instances?.['total_instances'], 'v_quality_instance.total_instances'),
      unmapped: integer(instances?.['unmapped_instances'], 'v_quality_instance.unmapped_instances'),
    },
    mame_version: metaValue(db, 'mame_version'),
    schema_version: metaValue(db, 'schema_version'),
    threshold_version: metaValue(db, 'threshold_version'),
    warnings_by_code: warnings,
  };
}

/**
 * §8's formatting: keys bytewise ascending at every level, two-space indent, one trailing
 * newline (data-model.md §4.3). The literal above is already in that order, and
 * `warnings_by_code` arrives from an `ORDER BY code` under SQLite's `BINARY` collation,
 * which is bytewise; the assertion below is what stops a future edit from quietly
 * reordering a member.
 */
export function formatQualityReport(report: QualityReport): string {
  assertKeyOrder(report as unknown as Record<string, unknown>, '');
  return `${JSON.stringify(report, null, 2)}\n`;
}

function assertKeyOrder(value: Record<string, unknown>, path: string): void {
  const keys = Object.keys(value);
  const sorted = [...keys].sort(compareBytes);
  if (keys.join(',') !== sorted.join(',')) {
    throw new Error(
      `quality report keys at '${path || '(root)'}' are not bytewise ascending: ` +
        `[${keys.join(', ')}] (data-quality.md §8)`,
    );
  }
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'object' && child !== null && !Array.isArray(child)) {
      assertKeyOrder(child as Record<string, unknown>, path === '' ? key : `${path}.${key}`);
    }
  }
}

// ---------------------------------------------------------------------------
// The warning-code registry, in two places that must agree
// ---------------------------------------------------------------------------

/**
 * Every code `v_quality_warning` can emit, read out of the shipped view itself.
 *
 * The same technique as `db/thresholds.ts`'s `requiredThresholds`, and for the same
 * reason: the view *is* the registry (data-quality.md §4 calls it closed), so discovering
 * the code set from the view's own SQL means adding a branch adds a code with no second
 * edit anywhere.
 */
export function warningCodeRegistry(db: DatabaseSync): string[] {
  const row = db
    .prepare("SELECT sql FROM sqlite_schema WHERE type = 'view' AND name = 'v_quality_warning'")
    .get();
  const sql = row?.['sql'];
  if (typeof sql !== 'string') {
    throw new Error('no view v_quality_warning in schemas/schema.sql');
  }
  const codes = new Set<string>();
  for (const match of sql.matchAll(/SELECT\s+'([A-Z][A-Z0-9_]*)'/g)) {
    const code = match[1];
    if (code !== undefined) codes.add(code);
  }
  return [...codes].sort(compareBytes);
}

/** The keys `quality-report.schema.json` permits under `warnings_by_code`. */
export function reportSchemaCodes(schemasDir = SCHEMAS_DIR): string[] {
  const raw: unknown = JSON.parse(
    readFileSync(join(schemasDir, 'quality-report.schema.json'), 'utf8'),
  );
  const properties = (raw as Record<string, unknown>)['properties'];
  const warnings = (properties as Record<string, unknown> | undefined)?.['warnings_by_code'];
  const propertyNames = (warnings as Record<string, unknown> | undefined)?.['propertyNames'];
  const enumerated = (propertyNames as Record<string, unknown> | undefined)?.['enum'];
  if (!Array.isArray(enumerated)) {
    throw new Error(
      'schemas/quality-report.schema.json: warnings_by_code.propertyNames.enum is missing',
    );
  }
  return enumerated.filter((code): code is string => typeof code === 'string').sort(compareBytes);
}

/**
 * The two copies of the closed registry, compared — the same drift guard `diffRowSchemas`
 * gives the row schemas, for the same reason: a JSON Schema that mirrors a SQL artifact
 * can go stale, and only a mechanical comparison notices.
 *
 * A code the view can emit but the schema forbids is fatal *whether or not it fires
 * today*: the build would produce an unrepresentable report the first time one curated
 * row moved, and the failure would arrive weeks later attached to an unrelated change.
 * Checking it up front, before any data is read, makes it a property of the two shipped
 * artifacts rather than of the dataset that happens to be in the tree.
 */
export function reportRegistryDrift(db: DatabaseSync, schemasDir = SCHEMAS_DIR): string[] {
  const view = warningCodeRegistry(db);
  const schema = reportSchemaCodes(schemasDir);
  const missing = view.filter((code) => !schema.includes(code));
  const extra = schema.filter((code) => !view.includes(code));
  const problems: string[] = [];
  if (missing.length > 0) {
    problems.push(
      `schemas/quality-report.schema.json omits ${missing.length} code(s) that v_quality_warning ` +
        `emits: ${missing.join(', ')}. Add them to properties.warnings_by_code.propertyNames.enum — ` +
        'the registry is closed (data-quality.md §4) and both files state it, so both must state it identically.',
    );
  }
  if (extra.length > 0) {
    problems.push(
      `schemas/quality-report.schema.json enumerates ${extra.length} code(s) v_quality_warning ` +
        `cannot emit: ${extra.join(', ')}. Delete them, or add the missing branch to the view.`,
    );
  }
  return problems;
}

/**
 * Validates the report against `schemas/quality-report.schema.json` and returns every
 * problem. "A malformed health report is a build failure like any other" (§8), so the
 * caller treats a non-empty result as fatal and writes nothing.
 */
export function validateQualityReport(report: QualityReport, schemasDir = SCHEMAS_DIR): string[] {
  const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
  addFormats(ajv);
  // The report schema `$ref`s common.schema.json for `text` and `semver`.
  ajv.addSchema(
    JSON.parse(readFileSync(join(schemasDir, 'common.schema.json'), 'utf8')) as Record<
      string,
      unknown
    >,
  );
  const validator = ajv.compile(
    JSON.parse(readFileSync(join(schemasDir, 'quality-report.schema.json'), 'utf8')) as Record<
      string,
      unknown
    >,
  );
  if (validator(report)) return [];
  return (validator.errors ?? []).map(
    (error) => `${error.instancePath || '(root)'} ${error.message ?? 'is invalid'}`,
  );
}
