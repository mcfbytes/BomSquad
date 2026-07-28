/**
 * TASKS T6.4 — the FAIL gates, and the one correction pass they bracket.
 *
 * docs/data-quality.md §9: "The whole of §3 is 'each query returns zero rows'. Implement
 * it as one loop over a list of (code, sql) pairs, printing the offending rows. That is
 * the entire integrity checker." This file is that list and that loop, and nothing else.
 *
 * Two of §3's six conditions are not SQL and are not here:
 *
 * - `DB_OVER_BUDGET` is a `stat` of the finished file (§3.1) — see `build/size.ts`.
 * - `NONDETERMINISTIC_BUILD` compares two builds' hashes (§3.2), which one process cannot
 *   do to itself; CI runs the build twice and compares. `build/index.ts` returns the
 *   digest that comparison uses.
 *
 * Everything else §5.4 lists is already enforced by the DDL and by `PRAGMA
 * foreign_key_check` / `integrity_check`, which `db/schema.ts`'s `checkIntegrity` runs.
 * Nothing here re-implements one of those, and the queries below are reproduced from
 * data-quality.md §3 rather than rewritten, so a doc/code disagreement is a diff.
 */
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';

/** One FAIL gate: a code, the query that must return no rows, and why it exists. */
export interface IntegrityCheck {
  /** SCREAMING_SNAKE code from docs/data-quality.md §3. The registry is closed. */
  readonly code: string;
  /** Spec section, for the failure message. */
  readonly section: string;
  /** MUST return zero rows. Any row is the failure, and the row is the error message. */
  readonly sql: string;
}

/** A gate that tripped, with every offending row. */
export interface IntegrityFailure {
  readonly code: string;
  readonly section: string;
  readonly rows: readonly Readonly<Record<string, SQLOutputValue>>[];
}

/**
 * §3.4 `STALE_CORRECTION`. Runs **before** the correction pass, against the freshly
 * loaded `machine_chip` — after the pass, a `remove` that matched nothing and a `remove`
 * that worked are indistinguishable, which is precisely the rot this catches.
 */
export const STALE_CORRECTION: IntegrityCheck = {
  code: 'STALE_CORRECTION',
  section: '§3.4',
  sql: `SELECT c.machine_id, c.mame_tag, c.chip_id, c.op, c.reason
FROM machine_chip_correction c
WHERE (c.op IN ('remove','set')
       AND NOT EXISTS (SELECT 1 FROM machine_chip m
                       WHERE m.machine_id = c.machine_id AND m.mame_tag = c.mame_tag
                         AND m.chip_id = c.chip_id))
   OR (c.op = 'add'
       AND EXISTS (SELECT 1 FROM machine_chip m
                   WHERE m.machine_id = c.machine_id AND m.mame_tag = c.mame_tag
                     AND m.chip_id = c.chip_id))
ORDER BY c.machine_id, c.mame_tag, c.chip_id`,
};

/**
 * data-model.md §5.1, verbatim and in order: remove, add, set.
 *
 * **This is the only mutation of loaded data anywhere in the build, and it is deliberate.**
 * `machine_correction` and `machine_system` need no pass at all — `v_machine` and
 * `v_machine_system` apply them with a `COALESCE` and a `CASE`, at query time, in the
 * shipped database. `machine_chip_correction` is the one exception the spec makes, because
 * a BOM correction adds and removes *rows* and `v_machine_bom` is a `UNION ALL` that reads
 * `machine_chip` directly; §5.2 depends on it ("Corrections do move [the headline metric],
 * because they are applied to `machine_chip` before the metric is read"), and §3.4 exists
 * only because there is a pass for it to run before.
 *
 * What is *not* corrected is `extract/machine_chip.json`. The correction rows ship in the
 * database beside the corrected table, so provenance stays a `LEFT JOIN` and the generated
 * file stays a pure function of MAME plus the device map.
 */
export const CORRECTION_PASS: readonly { readonly op: string; readonly sql: string }[] = [
  {
    op: 'remove',
    sql: `DELETE FROM machine_chip WHERE (machine_id, mame_tag, chip_id) IN
  (SELECT machine_id, mame_tag, chip_id FROM machine_chip_correction WHERE op = 'remove')`,
  },
  {
    op: 'add',
    sql: `INSERT INTO machine_chip (machine_id, mame_tag, chip_id, clock_hz, quantity)
SELECT machine_id, mame_tag, chip_id, clock_hz, COALESCE(quantity, 1)
FROM machine_chip_correction WHERE op = 'add'`,
  },
  {
    op: 'set',
    sql: `UPDATE machine_chip SET
  clock_hz = COALESCE((SELECT c.clock_hz FROM machine_chip_correction c
                       WHERE c.machine_id = machine_chip.machine_id
                         AND c.mame_tag = machine_chip.mame_tag
                         AND c.chip_id  = machine_chip.chip_id AND c.op = 'set'), clock_hz),
  quantity = COALESCE((SELECT c.quantity FROM machine_chip_correction c
                       WHERE c.machine_id = machine_chip.machine_id
                         AND c.mame_tag = machine_chip.mame_tag
                         AND c.chip_id  = machine_chip.chip_id AND c.op = 'set'), quantity)
WHERE EXISTS (SELECT 1 FROM machine_chip_correction c
              WHERE c.machine_id = machine_chip.machine_id AND c.mame_tag = machine_chip.mame_tag
                AND c.chip_id = machine_chip.chip_id AND c.op = 'set')`,
  },
];

/** The four SQL gates that run against the finished database, after the correction pass. */
export const POST_CORRECTION_CHECKS: readonly IntegrityCheck[] = [
  {
    code: 'RETIRED_ID_COLLISION',
    section: '§3.3',
    sql: `SELECT 'chip' AS entity, n.name AS name, n.chip_id AS claimed_by
FROM chip_name n JOIN chip c ON c.chip_id = n.name
UNION ALL
SELECT 'system', n.name, n.system_id
FROM system_name n JOIN system s ON s.system_id = n.name
ORDER BY 1, 2`,
  },
  {
    code: 'STALE_EXTRACT',
    section: '§3.5',
    sql: `SELECT DISTINCT d.mame_device
FROM machine_unmapped_device d
JOIN mame_device md ON md.mame_device = d.mame_device
ORDER BY 1`,
  },
  {
    code: 'DEPENDENCY_CYCLE',
    section: '§3.6',
    sql: `WITH RECURSIVE walk(root, node, depth) AS (
  SELECT consumer_id, provider_id, 1 FROM implementation_dependency
  UNION ALL
  SELECT w.root, d.provider_id, w.depth + 1
  FROM walk w
  JOIN implementation_dependency d ON d.consumer_id = w.node
  WHERE w.depth < (SELECT COUNT(*) FROM implementation)
)
SELECT DISTINCT root AS implementation_id FROM walk WHERE node = root ORDER BY 1`,
  },
  {
    code: 'DATASET_META_INCOMPLETE',
    section: '§3.7',
    sql: `SELECT k.key
FROM (SELECT 'build_date' AS key UNION ALL SELECT 'dataset_version'
      UNION ALL SELECT 'mame_version' UNION ALL SELECT 'schema_version') k
WHERE NOT EXISTS (SELECT 1 FROM dataset_meta m WHERE m.key = k.key)
ORDER BY 1`,
  },
];

/** Runs each check and collects the ones that returned rows. The whole checker. */
export function runIntegrityChecks(
  db: DatabaseSync,
  checks: readonly IntegrityCheck[],
): IntegrityFailure[] {
  const failures: IntegrityFailure[] = [];
  for (const check of checks) {
    const rows = db.prepare(check.sql).all();
    if (rows.length > 0) failures.push({ code: check.code, section: check.section, rows });
  }
  return failures;
}

/** Row counts the correction pass touched, for the build log and the `op='add'` audit. */
export interface CorrectionCounts {
  readonly removed: number;
  readonly added: number;
  readonly set: number;
}

/** Applies data-model.md §5.1's three statements and reports what each changed. */
export function applyCorrections(db: DatabaseSync): CorrectionCounts {
  const changes = new Map<string, number>();
  for (const { op, sql } of CORRECTION_PASS) {
    changes.set(op, Number(db.prepare(sql).run().changes));
  }
  return {
    removed: changes.get('remove') ?? 0,
    added: changes.get('add') ?? 0,
    set: changes.get('set') ?? 0,
  };
}

/** One failure, rendered so the offending rows are the error message (§3). */
export function formatIntegrityFailure(failure: IntegrityFailure, limit = 20): string {
  const lines = [
    `FAIL ${failure.code} (data-quality.md ${failure.section}): ${failure.rows.length} row(s)`,
  ];
  for (const row of failure.rows.slice(0, limit)) lines.push(`  ${JSON.stringify(row)}`);
  if (failure.rows.length > limit) {
    lines.push(`  … ${failure.rows.length - limit} more`);
  }
  return lines.join('\n');
}
