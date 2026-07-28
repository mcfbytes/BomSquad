/**
 * The size budget — two numbers, from two normative documents, meaning two different
 * things.
 *
 * They are stated separately and they differ, so this module reconciles them once,
 * explicitly, rather than letting a build silently pick one:
 *
 * | source                       | number                        | what it is                                 |
 * | ---------------------------- | ----------------------------- | ------------------------------------------ |
 * | data-model.md §4.3           | **48 MB** (`db_max_bytes`,    | a **hard ceiling**. "MUST NOT exceed …;     |
 * |                              | 50 331 648 B = 48 MiB exactly)| CI fails otherwise." → `DB_OVER_BUDGET`.   |
 * | ADR 0001 "Revisit trigger"   | **32 MiB raw / 8 MiB brotli** | a **warning line**. "Re-open this decision |
 * |                              |                               | when …" → not a failure.                   |
 *
 * ADR 0001 derives its own figure from the other — "32 MiB raw (**two-thirds of the
 * 48 MiB budget in `docs/data-model.md` §4.3**)" — so the two are one policy at two
 * levels, not a contradiction: cross 32 MiB and the whole-file-download architecture is
 * due for review; cross 48 MiB and the build must not publish. Implementing only the
 * ceiling would let the file grow to 47 MiB with nobody told; implementing only the
 * trigger would turn an architectural prompt into a build break. So: the ceiling FAILs,
 * the trigger WARNs, and neither number is written in this file.
 *
 * `db_max_bytes` lives in `config/quality-thresholds.json` (data-quality.md §7) and is
 * read back out of the `threshold` table the build already loads, so CI and the doc
 * cannot disagree. The ADR's two figures live in `config/build.json`; they are not
 * quality thresholds — data-quality.md §7 closes that key set at nine — and no shipped
 * view reads them.
 */
import { readFileSync, statSync } from 'node:fs';
import { brotliCompressSync, constants as zlib } from 'node:zlib';
import { join } from 'node:path';

import type { DatabaseSync } from 'node:sqlite';

import { REPO_ROOT } from '../mame/config.js';

export const BUILD_CONFIG_PATH = join(REPO_ROOT, 'pipeline', 'config', 'build.json');

/** ADR 0001's revisit trigger. Not a threshold: no view reads it and it fails nothing. */
export interface RevisitTrigger {
  readonly rawBytes: number;
  readonly brotliBytes: number;
}

export interface BuildConfig {
  readonly revisitTrigger: RevisitTrigger;
  readonly version: string;
}

function positive(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${BUILD_CONFIG_PATH}: ${where} must be a positive integer`);
  }
  return value;
}

export function loadBuildConfig(path = BUILD_CONFIG_PATH): BuildConfig {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof raw !== 'object' || raw === null) throw new Error(`${path}: expected a JSON object`);
  const record = raw as Record<string, unknown>;
  const trigger = record['revisit_trigger'];
  if (typeof trigger !== 'object' || trigger === null) {
    throw new Error(`${path}: 'revisit_trigger' must be an object`);
  }
  const triggerRecord = trigger as Record<string, unknown>;
  const version = record['version'];
  if (typeof version !== 'string' || version === '') {
    throw new Error(`${path}: 'version' must be a non-empty string`);
  }
  return {
    revisitTrigger: {
      rawBytes: positive(triggerRecord['raw_bytes'], 'revisit_trigger.raw_bytes'),
      brotliBytes: positive(triggerRecord['brotli_bytes'], 'revisit_trigger.brotli_bytes'),
    },
    version,
  };
}

/**
 * The hard ceiling, read from the `threshold` table the build has already loaded.
 *
 * Reading it back from the database rather than from the parsed config is not ceremony:
 * `loadThresholds` is what guarantees a threshold exists and is a number, and a build that
 * consulted the JSON directly would be a second reader with none of that guarantee.
 */
export function databaseSizeLimit(db: DatabaseSync): number {
  const row = db.prepare("SELECT value FROM threshold WHERE name = 'db_max_bytes'").get();
  const value = row?.['value'];
  if (typeof value !== 'number') {
    throw new Error(
      "threshold 'db_max_bytes' is missing from the database: config/quality-thresholds.json " +
        'must declare it (data-quality.md §3.1)',
    );
  }
  return value;
}

export interface SizeReport {
  readonly rawBytes: number;
  readonly brotliBytes: number;
  /** `db_max_bytes`. Exceeding it is `DB_OVER_BUDGET` and fails the build. */
  readonly limitBytes: number;
  readonly trigger: RevisitTrigger;
  /** Empty unless the hard ceiling was crossed. */
  readonly failures: readonly string[];
  /** ADR 0001 revisit-trigger crossings. Advisory, never fatal. */
  readonly warnings: readonly string[];
}

/**
 * Brotli at quality 11 — the same setting ADR 0001 measured its 8 MiB trigger with, and
 * what Azure Static Web Apps serves. A cheaper quality would report a transfer size the
 * user never sees and compare it to a trigger derived from a different one.
 */
export function brotliSize(bytes: Buffer): number {
  return brotliCompressSync(bytes, {
    params: {
      [zlib.BROTLI_PARAM_QUALITY]: zlib.BROTLI_MAX_QUALITY,
      [zlib.BROTLI_PARAM_SIZE_HINT]: bytes.length,
    },
  }).length;
}

const mib = (bytes: number): string => `${(bytes / (1 << 20)).toFixed(2)} MiB`;

/** Measures the published file and applies both levels of the budget. */
export function checkSize(path: string, limitBytes: number, trigger: RevisitTrigger): SizeReport {
  const rawBytes = statSync(path).size;
  const brotliBytes = brotliSize(readFileSync(path));
  const failures: string[] = [];
  const warnings: string[] = [];

  if (rawBytes > limitBytes) {
    failures.push(
      `DB_OVER_BUDGET (data-quality.md §3.1): ${path} is ${mib(rawBytes)}, over the ` +
        `${mib(limitBytes)} ceiling in data-model.md §4.3. The fix is §4.3's escape hatch — ` +
        'split per-title machine_chip detail into a second, lazily-fetched database — never a chunking format.',
    );
  }
  if (rawBytes > trigger.rawBytes) {
    warnings.push(
      `ADR 0001 revisit trigger: ${mib(rawBytes)} raw exceeds ${mib(trigger.rawBytes)}. ` +
        'Re-open docs/adr/0001-browser-database.md — the whole-file download is due for review.',
    );
  }
  if (brotliBytes > trigger.brotliBytes) {
    warnings.push(
      `ADR 0001 revisit trigger: ${mib(brotliBytes)} brotli exceeds ${mib(trigger.brotliBytes)}. ` +
        'Re-open docs/adr/0001-browser-database.md — the transfer cost is due for review.',
    );
  }
  return { rawBytes, brotliBytes, limitBytes, trigger, failures, warnings };
}
