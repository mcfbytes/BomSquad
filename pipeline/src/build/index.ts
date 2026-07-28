/**
 * TASKS T6.5 — `pipeline build`. The one artifact, assembled.
 *
 * The order below is not improvised: it is docs/data-quality.md §9's implementation note,
 * which is itself the composition of data-model.md §4.3's SQLite recipe and §5's
 * correction semantics. Each step is here because moving it changes an answer.
 *
 * ```
 *  1  apply schemas/schema.sql            OUTSIDE any transaction (§4.3 — see below)
 *  2  load data/ + extract/ row files     db/load.ts, foreign keys off, one transaction
 *  3  STALE_CORRECTION                    §3.4 — MUST precede the pass it audits
 *  4  correction pass                     §5.1 — machine_chip only; the rest are views
 *  5  foreign_key_check + integrity_check  §5.4 — free, and now covers the added rows
 *  6  load thresholds                     typed table; fails if a gate could not fire
 *  7  dataset_meta build facts            build_date, dataset_version, schema/threshold
 *  8  RETIRED_ID_COLLISION, STALE_EXTRACT, DEPENDENCY_CYCLE, DATASET_META_INCOMPLETE
 *  9  collect the report's scalars        from the shipped views
 * 10  ANALYZE; VACUUM                     §4.3 — normalizes page layout
 * 11  DB_OVER_BUDGET + ADR 0001 trigger   stat, not SQL
 * 12  publish                             rename into place, then write the report
 * ```
 *
 * **Why `PRAGMA foreign_keys` must not run inside a transaction.** SQLite ignores the
 * pragma between `BEGIN` and `COMMIT` and reports no error. A builder that wrapped the DDL
 * in a transaction "for speed" would therefore ship a database with referential
 * enforcement silently off and never find out — every dangling reference would load
 * cleanly and every `foreign_key_check` in CI would pass against a file the browser then
 * queries wrongly. `applySchema()` reads the pragma back and throws; step 1 is outside any
 * transaction so that it can. The loader's own `PRAGMA foreign_keys = OFF` is a different
 * thing and is deliberate: it is executed *outside* the load transaction (so it takes
 * effect), it lets rows land in any table order, and `foreign_key_check` at step 5 is the
 * enforcement that replaces it.
 *
 * **Nothing is published until every gate has passed.** The database is built at a
 * temporary path inside `dist/` and renamed into place at step 12, so a failed build
 * leaves `dist/` exactly as it found it (data-quality.md §3: "exit non-zero, publish
 * nothing, leave `dist/` untouched").
 *
 * **Determinism.** No wall clock reaches the file: `build_date` is an input (a CLI flag,
 * `SOURCE_DATE_EPOCH`, or — only as a last resort — today's UTC date), `dataset_version`
 * defaults to it, and every row is inserted in primary-key order before `VACUUM`
 * normalizes the page layout. `sha256` is returned so CI can run this twice and compare
 * (`NONDETERMINISTIC_BUILD`, §3.2), which is the one gate a single process cannot run
 * against itself.
 */
import { createHash } from 'node:crypto';
import { hrtime } from 'node:process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { applySchema, checkIntegrity, SCHEMA_VERSION } from '../db/schema.js';
import { loadDataset, type LoadResult } from '../db/load.js';
import { loadThresholds } from '../db/thresholds.js';
import { REPO_ROOT } from '../mame/config.js';
import {
  applyCorrections,
  formatIntegrityFailure,
  POST_CORRECTION_CHECKS,
  runIntegrityChecks,
  STALE_CORRECTION,
  type CorrectionCounts,
} from './integrity.js';
import {
  collectQualityReport,
  formatQualityReport,
  QUALITY_REPORT_FILE,
  reportRegistryDrift,
  validateQualityReport,
  type QualityReport,
} from './report.js';
import {
  checkSize,
  databaseSizeLimit,
  loadBuildConfig,
  type BuildConfig,
  type SizeReport,
} from './size.js';

export const DATABASE_FILE = 'bomsquad.sqlite';
export const DIST_DIR = join(REPO_ROOT, 'dist');
export const DATA_DIR = join(REPO_ROOT, 'data');
export const EXTRACT_DIR = join(REPO_ROOT, 'extract');
export const THRESHOLDS_PATH = join(REPO_ROOT, 'pipeline', 'config', 'quality-thresholds.json');

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface BuildOptions {
  /** Row-file roots. Defaults to `data/` and `extract/`. */
  readonly roots?: readonly string[];
  /** Where `bomsquad.sqlite` and `quality-report.json` go. Defaults to `dist/`. */
  readonly outputDir?: string;
  /** `dataset_meta.build_date`, `YYYY-MM-DD`. Defaults per {@link resolveBuildDate}. */
  readonly buildDate?: string;
  /** `dataset_meta.dataset_version`. Defaults to the build date (versioning.md §2). */
  readonly datasetVersion?: string;
  readonly thresholds?: Readonly<Record<string, unknown>>;
  readonly buildConfig?: BuildConfig;
  /** Where `quality-report.schema.json` is read from. A test seam; defaults to `schemas/`. */
  readonly schemasDir?: string;
  readonly log?: (line: string) => void;
}

export interface BuildResult {
  readonly databasePath: string;
  readonly reportPath: string;
  readonly report: QualityReport;
  readonly size: SizeReport;
  /** SHA-256 of the published file — CI's `NONDETERMINISTIC_BUILD` comparand. */
  readonly sha256: string;
  readonly load: LoadResult;
  readonly corrections: CorrectionCounts;
  readonly buildDate: string;
  readonly datasetVersion: string;
  readonly wallClockMs: number;
}

/** A gate tripped. Carries every message so one run reports every failure it found. */
export class BuildFailure extends Error {
  readonly failures: readonly string[];
  constructor(failures: readonly string[]) {
    super(failures.join('\n\n'));
    this.name = 'BuildFailure';
    this.failures = failures;
  }
}

/**
 * `build_date`, in descending order of reproducibility: the caller's flag, then
 * `SOURCE_DATE_EPOCH` (the reproducible-builds convention, which CI sets from the commit
 * so rebuilding an old commit reproduces its warnings exactly), then today's UTC date.
 *
 * The last of those is the only clock reading anywhere in the build, and it exists so a
 * contributor can run `pipeline build` without ceremony. A release must not rely on it:
 * two builds either side of midnight UTC would differ, which is exactly what the other two
 * sources are for.
 */
export function resolveBuildDate(
  explicit?: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (explicit !== undefined) {
    if (!DATE.test(explicit)) throw new Error(`build date '${explicit}' is not YYYY-MM-DD`);
    return explicit;
  }
  const epoch = env['SOURCE_DATE_EPOCH'];
  if (epoch !== undefined && epoch.trim() !== '') {
    const seconds = Number(epoch);
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new Error(`SOURCE_DATE_EPOCH='${epoch}' is not a Unix timestamp`);
    }
    return new Date(seconds * 1000).toISOString().slice(0, 10);
  }
  return new Date().toISOString().slice(0, 10);
}

function readThresholdConfig(path = THRESHOLDS_PATH): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${path}: expected a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** Build facts, written by the build and by nothing else (data-model.md §1.5). */
function writeBuildFacts(db: DatabaseSync, facts: Readonly<Record<string, string>>): void {
  const statement = db.prepare('INSERT OR REPLACE INTO dataset_meta (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(facts)) statement.run(key, value);
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Runs the whole build. Throws {@link BuildFailure} without publishing if a gate trips. */
export function buildDatabase(options: BuildOptions = {}): BuildResult {
  const started = hrtime.bigint();
  const log = options.log ?? ((): void => undefined);
  const roots = options.roots ?? [DATA_DIR, EXTRACT_DIR];
  const outputDir = options.outputDir ?? DIST_DIR;
  const buildConfig = options.buildConfig ?? loadBuildConfig();
  const thresholds = options.thresholds ?? readThresholdConfig();
  const buildDate = resolveBuildDate(options.buildDate);
  const datasetVersion = options.datasetVersion ?? buildDate;
  const thresholdVersion = thresholds['version'];
  if (typeof thresholdVersion !== 'string') {
    throw new Error("config/quality-thresholds.json: 'version' must be a string (§7)");
  }

  mkdirSync(outputDir, { recursive: true });
  const databasePath = join(outputDir, DATABASE_FILE);
  // Built aside and renamed on success, so a failed gate leaves dist/ untouched (§3).
  const stagingPath = `${databasePath}.staging`;
  for (const suffix of ['', '-journal', '-wal', '-shm'])
    rmSync(`${stagingPath}${suffix}`, { force: true });

  const db = new DatabaseSync(stagingPath);
  let open = true;
  let published = false;
  const close = (): void => {
    if (!open) return;
    open = false;
    db.close();
  };
  try {
    // 1. The DDL, outside any transaction: applySchema reads PRAGMA foreign_keys back.
    db.exec('PRAGMA journal_mode = DELETE');
    applySchema(db);

    // Not a gate — a diagnosis, held in case step 12 rejects the report. `v_quality_warning`
    // and `quality-report.schema.json` both state the closed code registry of
    // data-quality.md §4, and when they disagree ajv says only "property name must be
    // valid", which names neither the code nor the file to fix. Whether the two agree is a
    // property of the shipped artifacts, so the *gate* for it is a test
    // (`test/build.test.ts`), exactly as `diffRowSchemas` guards the row schemas from the
    // test suite rather than from the build.
    const registryDrift = describeRegistryDrift(db, options.schemasDir);

    // 2. The loader, reused verbatim.
    const load = loadDataset(db, roots);
    log(`build: loaded ${load.total} rows from ${load.files.length} row files`);

    // 3-4. Audit the corrections, then apply the one pass §5.1 defines.
    fail(runIntegrityChecks(db, [STALE_CORRECTION]).map((f) => formatIntegrityFailure(f)));
    const corrections = applyCorrections(db);
    log(
      `build: corrections applied to machine_chip — ${corrections.removed} removed, ` +
        `${corrections.added} added, ${corrections.set} set (data-model.md §5.1)`,
    );

    // 5. The free half of §5.4.
    const problems = checkIntegrity(db);
    if (problems.length > 0) throw new BuildFailure(problems);

    // 6. Policy, typed, with the loader asserting no gate went quiet. The ceiling is read
    //    back out of the table rather than off the parsed config, so the number the build
    //    enforces is the number the database ships.
    loadThresholds(db, thresholds);
    const limitBytes = databaseSizeLimit(db);

    // 7. Build facts. mame_version arrives with extract/dataset_meta.json (§4.2).
    writeBuildFacts(db, {
      build_date: buildDate,
      dataset_version: datasetVersion,
      schema_version: SCHEMA_VERSION,
      threshold_version: thresholdVersion,
    });

    // 8. The remaining SQL gates.
    fail(runIntegrityChecks(db, POST_CORRECTION_CHECKS).map((f) => formatIntegrityFailure(f)));

    // 9. Every scalar the report carries, from the shipped views, before VACUUM moves
    //    pages around — none of them is a property of the file's layout.
    const scalars = collectQualityReport(db, 0);

    // 10. §4.3's recipe, in its order: statistics, then the compaction that makes a
    //     double build byte-comparable.
    db.exec('ANALYZE');
    db.exec('VACUUM');
    // Closing here makes VACUUM the last write to the file: everything below only reads
    // it, so the bytes hashed in step 12 are the bytes VACUUM produced.
    close();

    // 11. The budget, at both of its levels (see build/size.ts).
    const size = checkSize(stagingPath, limitBytes, buildConfig.revisitTrigger);
    for (const warning of size.warnings) log(`WARN ${warning}`);
    if (size.failures.length > 0) throw new BuildFailure(size.failures);

    const report: QualityReport = { ...scalars, db_bytes: size.rawBytes };
    const errors = validateQualityReport(report, options.schemasDir);
    if (errors.length > 0) {
      throw new BuildFailure([
        `the quality report does not validate against schemas/quality-report.schema.json:\n  ${errors.join('\n  ')}`,
        ...registryDrift,
      ]);
    }

    // 12. Publish. The report is serialised *before* the rename — it is the last thing
    //     that can fail, and nothing may be published until nothing can.
    const reportText = formatQualityReport(report);
    renameSync(stagingPath, databasePath);
    published = true;
    const reportPath = join(outputDir, QUALITY_REPORT_FILE);
    writeFileSync(reportPath, reportText);

    return {
      databasePath,
      reportPath,
      report,
      size,
      sha256: sha256(databasePath),
      load,
      corrections,
      buildDate,
      datasetVersion,
      wallClockMs: Number((hrtime.bigint() - started) / 1_000_000n),
    };
  } finally {
    close();
    if (!published) rmSync(stagingPath, { force: true });
  }
}

function fail(messages: readonly string[]): void {
  if (messages.length > 0) throw new BuildFailure(messages);
}

/**
 * The registry comparison, made unable to fail the build on its own. It exists only to
 * explain a rejected report, so a report schema too malformed to compare against is
 * reported by ajv — which is the thing that actually decides — rather than by a helper
 * that would pre-empt it with a worse message.
 */
function describeRegistryDrift(db: DatabaseSync, schemasDir: string | undefined): string[] {
  try {
    return reportRegistryDrift(db, schemasDir);
  } catch {
    return [];
  }
}

/** The build log: the numbers a reviewer checks, and nothing that varies run to run. */
export function formatBuildLog(result: BuildResult): string {
  const { report, size } = result;
  const mib = (bytes: number): string => `${(bytes / (1 << 20)).toFixed(2)} MiB`;
  const lines = [
    `build: ${result.databasePath}`,
    `  dataset ${result.datasetVersion} · MAME ${report.mame_version} · schema ${report.schema_version} · thresholds ${report.threshold_version}`,
    `  rows    ${result.load.total} from ${result.load.files.length} files`,
    `  counts  chip ${report.counts.chip} · system ${report.counts.system} · machine ${report.counts.machine} · implementation ${report.counts.implementation} · project ${report.counts.project}`,
    `  mapped  ${report.instances.mapped} of ${report.instances.total} device instances (${report.instances.mapped_instance_share})`,
    `  devices ${report.devices.mapped} mapped · ${report.devices.ignored} ignored · ${report.devices.unmapped} unmapped`,
    `  size    ${mib(size.rawBytes)} raw · ${mib(size.brotliBytes)} brotli · ceiling ${mib(size.limitBytes)}`,
    `  sha256  ${result.sha256}`,
  ];
  const codes = Object.entries(report.warnings_by_code);
  lines.push(
    codes.length === 0
      ? '  warnings none'
      : `  warnings ${codes.map(([code, count]) => `${code} ${count}`).join(' · ')}`,
  );
  lines.push(`  wrote   ${result.reportPath}`);
  lines.push(`  wall clock ${(result.wallClockMs / 1000).toFixed(1)}s`);
  return `${lines.join('\n')}\n`;
}
