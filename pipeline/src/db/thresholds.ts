/**
 * Quality thresholds: `pipeline/config/quality-thresholds.json` → the `threshold` table.
 *
 * The quality views take no parameters (data-quality.md §7), so their policy has to live
 * in the database. It used to live in `dataset_meta` as untyped `threshold.<key>` text,
 * which failed open twice over: a value that stopped parsing `CAST`ed to `0.0` and
 * quietly disabled its own comparison, and a missing row made the comparison `NULL`,
 * which is never true. Either way the gate switched itself off and said nothing.
 *
 * Two changes fix that, and both are here:
 *
 * 1. The destination is typed — `threshold(name TEXT PRIMARY KEY, value REAL NOT NULL
 *    CHECK (value >= 0))` — so a malformed value cannot be stored at all.
 * 2. {@link loadThresholds} refuses to finish unless every threshold the shipped views
 *    read is present. The required set is not written down twice: it is read out of the
 *    DDL, which is the only place that decides which names the views consult.
 *
 * `version` and any other non-numeric leaf is not a threshold. It goes to `dataset_meta`
 * as `threshold_version`, which is where genuinely free-form build facts belong.
 *
 * **The guarantee is load-time only.** The views read policy as a bare scalar subquery, so
 * a `threshold` row deleted from a database *after* loading reopens the original failure:
 * the subquery yields NULL, the comparison is never true, and the gate goes quiet again.
 * Nothing on a shipped build path skips {@link loadThresholds} today. The first code path
 * that populates `threshold` without going through it is reintroducing that bug — populate
 * the table only from here.
 */
import type { DatabaseSync } from 'node:sqlite';

import { readSchemaSql } from './schema.js';
import { compareBytes } from './rowfiles.js';

/** One numeric policy value, flattened from the config's nested shape. */
export interface Threshold {
  /** Dotted config path, e.g. `issue_generator.min_instance_count`. */
  readonly name: string;
  readonly value: number;
}

/**
 * The threshold names the shipped views read, discovered from the DDL rather than
 * maintained beside it. Every quality view reads policy as
 * `(SELECT value FROM threshold WHERE name = '<name>')`, so this pattern *is* the
 * contract; adding a threshold to a view adds it here with no edit.
 */
export function requiredThresholds(sql: string = readSchemaSql()): string[] {
  const names = new Set<string>();
  for (const match of sql.matchAll(/FROM threshold WHERE name = '([^']+)'/g)) {
    const name = match[1];
    if (name !== undefined) names.add(name);
  }
  return [...names].sort(compareBytes);
}

/** Flattens the config's nested objects into dotted names, dropping non-numeric leaves. */
export function flattenThresholds(
  config: Readonly<Record<string, unknown>>,
  prefix = '',
): Threshold[] {
  const out: Threshold[] = [];
  for (const [key, value] of Object.entries(config)) {
    const name = prefix === '' ? key : `${prefix}.${key}`;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      out.push(...flattenThresholds(value as Record<string, unknown>, name));
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      out.push({ name, value });
    }
  }
  return out.sort((a, b) => compareBytes(a.name, b.name));
}

/**
 * Writes every numeric threshold and asserts the views' whole required set is present.
 * Throws — loudly, naming the missing names — rather than shipping a quality gate that
 * cannot fire. Returns the rows written, in insert order.
 */
export function loadThresholds(
  db: DatabaseSync,
  config: Readonly<Record<string, unknown>>,
  required: readonly string[] = requiredThresholds(),
): Threshold[] {
  const rows = flattenThresholds(config);
  const statement = db.prepare('INSERT OR REPLACE INTO threshold (name, value) VALUES (?, ?)');
  for (const row of rows) statement.run(row.name, row.value);

  const present = new Set(
    db
      .prepare('SELECT name FROM threshold')
      .all()
      .map((r) => r['name']),
  );
  const missing = required.filter((name) => !present.has(name)).sort(compareBytes);
  if (missing.length > 0) {
    throw new Error(
      `quality thresholds missing from pipeline/config/quality-thresholds.json: ${missing.join(', ')}. ` +
        'The views in schemas/schema.sql read these by name; without them the gates they guard cannot fire.',
    );
  }
  return rows;
}
