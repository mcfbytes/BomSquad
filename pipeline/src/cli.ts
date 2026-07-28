#!/usr/bin/env node
/**
 * BOM Squad pipeline CLI. Subcommands are pure functions of their inputs so runs are
 * reproducible.
 *
 *   pipeline validate [--strict] [--json]
 *   pipeline mame:fetch
 *   pipeline mame:extract
 *   pipeline mame:rows
 *   pipeline mame:bump-pin <release-tag>
 *   pipeline mame:refresh-summary <old-extract-dir> <new-extract-dir>
 *   pipeline build [--build-date <YYYY-MM-DD>] [--dataset-version <v>] [--out <dir>]
 *   pipeline prospector [--platform <id>] [--top <n>] [--db <path>] [--json]
 *   pipeline reconcile
 *   pipeline reconcile:guard [<root>]
 *
 * Exit codes: 0 clean (or warnings only), 1 at least one ERROR (or any WARN under
 * `--strict`), 2 bad usage.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { failed, formatJson, formatReport, type ReportOptions } from './validate/report.js';
import { validate } from './validate/index.js';
import { formatExtractionLog, runExtraction } from './mame/extract.js';
import { fetchListxml } from './mame/fetch.js';
import {
  bumpMameConfig,
  formatMameConfigJson,
  loadMameConfig,
  MAME_CONFIG_PATH,
} from './mame/config.js';
import { buildRefreshSummary, formatRefreshSummaryMarkdown } from './mame/refresh-summary.js';
import { createSchemaDatabase } from './db/schema.js';
import { describeTables } from './db/introspect.js';
import { emitExtractRowFiles, formatEmitLog } from './build/extract-rows.js';
import {
  buildDatabase,
  BuildFailure,
  DATA_DIR,
  DATABASE_FILE,
  DIST_DIR,
  EXTRACT_DIR,
  formatBuildLog,
  type BuildOptions,
} from './build/index.js';
import { formatProspectorReport, loadProspectorConfig, rankProspects } from './prospector/rank.js';
import { runReconcile } from './reconcile/index.js';
import { formatReportLog } from './reconcile/report.js';
import { formatGuardReport, runGuard } from './reconcile/guard.js';
import { loadReconcileConfig } from './reconcile/config.js';
import type { RawMachine } from './mame/parse.js';
import type { WorklistEntry } from './mame/worklist.js';

const COMMANDS = [
  'validate',
  'mame:fetch',
  'mame:extract',
  'mame:rows',
  'mame:bump-pin',
  'mame:refresh-summary',
  'build',
  'prospector',
  'reconcile',
  'reconcile:guard',
] as const;
type Command = (typeof COMMANDS)[number];

const VALIDATE_FLAGS = ['--strict', '--json'] as const;
type ValidateFlag = (typeof VALIDATE_FLAGS)[number];

function isCommand(value: string | undefined): value is Command {
  return COMMANDS.includes(value as Command);
}

function runValidate(argv: readonly string[]): number {
  for (const argument of argv) {
    if (!VALIDATE_FLAGS.includes(argument as ValidateFlag)) {
      process.stderr.write(`pipeline validate: unknown option '${argument}'\n`);
      process.stderr.write(`usage: pipeline validate [${VALIDATE_FLAGS.join('] [')}]\n`);
      return 2;
    }
  }
  const options: ReportOptions = { strict: argv.includes('--strict') };
  const result = validate();
  const render = argv.includes('--json') ? formatJson : formatReport;
  process.stdout.write(render(result, options));
  return failed(result, options) ? 1 : 0;
}

const write = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

async function runMameFetch(): Promise<number> {
  await fetchListxml(loadMameConfig(), { log: write });
  return 0;
}

/**
 * The extraction reports DDL refusals rather than throwing on them (see `mame/verify.ts`),
 * so the exit code is what makes them fail a build: a machine MAME describes in a way
 * `schemas/schema.sql` refuses is a real defect in one of the two, and a green run would
 * hide it until T6.1 tripped over it.
 *
 * Refusals listed in `config/mame-extract.json`'s `known_schema_violations` are still
 * printed, with the reason given for each, but do not fail the run — they are the ones
 * already known to be defects in the DDL rather than in the data.
 */
async function runMameExtract(): Promise<number> {
  const result = await runExtraction({ log: write });
  process.stdout.write(formatExtractionLog(result));
  return result.verification.unexpected.length > 0 ? 1 : 0;
}

/**
 * TASKS T6.1 — applies the curated `mame_device` map to `extract/machines.raw.json` and
 * writes the four row files of data-model.md §4.2.
 *
 * Separate from `mame:extract` because the two have different inputs and different reasons
 * to re-run: `mame:extract` needs a 20 MB download and only changes when the pin or the
 * filter policy does, whereas this needs neither and changes every time a curator maps a
 * device. Separate from `build` because its output is committed, so a curation PR shows
 * the machines and BOM rows it actually moves.
 */
function runMameRows(): number {
  const db = createSchemaDatabase();
  try {
    const schema = new Map(describeTables(db).map((info) => [info.name, info]));
    const result = emitExtractRowFiles({
      extractDir: EXTRACT_DIR,
      dataRoots: [DATA_DIR],
      schema,
    });
    process.stdout.write(formatEmitLog(result));
  } finally {
    db.close();
  }
  return 0;
}

const BUILD_FLAGS = ['--build-date', '--dataset-version', '--out'] as const;
type BuildFlag = (typeof BUILD_FLAGS)[number];

/**
 * TASKS T6.5 — assembles `dist/bomsquad.sqlite` and `dist/quality-report.json`.
 *
 * A tripped gate is reported in full and exits 1 with `dist/` untouched; anything else
 * (a malformed config, a schema that will not apply) is a defect rather than a data
 * problem and propagates as a stack trace.
 */
function runBuild(argv: readonly string[]): number {
  const options: {
    buildDate?: string;
    datasetVersion?: string;
    outputDir?: string;
  } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!BUILD_FLAGS.includes(flag as BuildFlag) || value === undefined) {
      process.stderr.write(`pipeline build: bad option '${String(flag)}'\n`);
      process.stderr.write(`usage: pipeline build [${BUILD_FLAGS.join(' <value>] [')} <value>]\n`);
      return 2;
    }
    if (flag === '--build-date') options.buildDate = value;
    else if (flag === '--dataset-version') options.datasetVersion = value;
    else options.outputDir = value;
    index += 1;
  }

  const buildOptions: BuildOptions = {
    ...(options.buildDate !== undefined ? { buildDate: options.buildDate } : {}),
    ...(options.datasetVersion !== undefined ? { datasetVersion: options.datasetVersion } : {}),
    outputDir: options.outputDir ?? DIST_DIR,
    log: write,
  };
  try {
    process.stdout.write(formatBuildLog(buildDatabase(buildOptions)));
  } catch (error) {
    if (!(error instanceof BuildFailure)) throw error;
    for (const failure of error.failures) process.stderr.write(`${failure}\n`);
    process.stderr.write('build: nothing published; dist/ is unchanged\n');
    return 1;
  }
  return 0;
}

const PROSPECTOR_VALUE_FLAGS = ['--platform', '--top', '--db'] as const;

/**
 * TASKS T6.3 — prints the weighted Prospector ranking from a built database.
 *
 * All scoring policy comes from `pipeline/config/prospector.json` via
 * `prospector/rank.ts`; this shim only parses flags and opens the file read-only. The
 * default database is the build artifact, so the ranking a reviewer sees is the ranking
 * the dataset ships.
 */
function runProspector(argv: readonly string[]): number {
  let platformId = 'mister';
  let top = 25;
  let dbPath = join(DIST_DIR, DATABASE_FILE);
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--json') {
      json = true;
      continue;
    }
    const value = argv[index + 1];
    if (
      !PROSPECTOR_VALUE_FLAGS.includes(flag as (typeof PROSPECTOR_VALUE_FLAGS)[number]) ||
      value === undefined
    ) {
      process.stderr.write(`pipeline prospector: bad option '${String(flag)}'\n`);
      process.stderr.write(
        `usage: pipeline prospector [${PROSPECTOR_VALUE_FLAGS.join(' <value>] [')} <value>] [--json]\n`,
      );
      return 2;
    }
    if (flag === '--platform') platformId = value;
    else if (flag === '--db') dbPath = value;
    else {
      top = Number(value);
      if (!Number.isInteger(top) || top < 1) {
        process.stderr.write(
          `pipeline prospector: --top must be a positive integer, got '${value}'\n`,
        );
        return 2;
      }
    }
    index += 1;
  }

  if (!existsSync(dbPath)) {
    process.stderr.write(
      `pipeline prospector: '${dbPath}' not found — run 'npm run build:db --workspace @bomsquad/pipeline' first\n`,
    );
    return 1;
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const ranking = rankProspects(db, loadProspectorConfig(), platformId, { limit: top });
    process.stdout.write(
      json ? `${JSON.stringify(ranking, null, 2)}\n` : formatProspectorReport(ranking),
    );
  } finally {
    db.close();
  }
  return 0;
}

/**
 * Bumps `pipeline/config/mame.json` to a new release tag (TASKS T2.6). The version and
 * asset name are derived, never typed by the caller — see `mame/config.ts`'s
 * `bumpMameConfig` — so the workflow that calls this only ever has to know the tag the
 * GitHub releases API gave it.
 */
function runMameBumpPin(argv: readonly string[]): number {
  const [release] = argv;
  if (release === undefined) {
    process.stderr.write('usage: pipeline mame:bump-pin <release-tag>\n');
    return 2;
  }
  const current = loadMameConfig();
  const bumped = bumpMameConfig(current, release);
  writeFileSync(MAME_CONFIG_PATH, formatMameConfigJson(bumped));
  write(
    `mame:bump-pin: ${current.release} (${current.version}) -> ${bumped.release} (${bumped.version})`,
  );
  return 0;
}

/** One field out of an `extract/*.raw.json` header-plus-array file, read with no trust. */
function readJsonArray(path: string, key: string): readonly unknown[] {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`${path}: expected a JSON object`);
  }
  const value = (raw as Record<string, unknown>)[key];
  if (!Array.isArray(value)) throw new Error(`${path}: '${key}' must be an array`);
  return value;
}

function readMameVersion(path: string): string {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const version =
    typeof raw === 'object' && raw !== null
      ? (raw as Record<string, unknown>)['mame_version']
      : undefined;
  if (typeof version !== 'string') throw new Error(`${path}: missing 'mame_version'`);
  return version;
}

/**
 * Diffs two `mame:extract` output directories and prints the PR body a refresh should
 * open with (TASKS T2.6). All the logic is `mame/refresh-summary.ts`'s pure functions;
 * this is the thin, untested-on-purpose I/O shim around them the workflow calls twice —
 * once against the extract already committed and once against what a fresh extraction
 * against the bumped pin just produced.
 */
function runMameRefreshSummary(argv: readonly string[]): number {
  const [oldDir, newDir] = argv;
  if (oldDir === undefined || newDir === undefined) {
    process.stderr.write(
      'usage: pipeline mame:refresh-summary <old-extract-dir> <new-extract-dir>\n',
    );
    return 2;
  }
  const summary = buildRefreshSummary({
    oldVersion: readMameVersion(join(oldDir, 'machines.raw.json')),
    newVersion: readMameVersion(join(newDir, 'machines.raw.json')),
    oldMachines: readJsonArray(join(oldDir, 'machines.raw.json'), 'machines') as RawMachine[],
    newMachines: readJsonArray(join(newDir, 'machines.raw.json'), 'machines') as RawMachine[],
    oldDevices: readJsonArray(join(oldDir, 'mame-devices.raw.json'), 'devices') as WorklistEntry[],
    newDevices: readJsonArray(join(newDir, 'mame-devices.raw.json'), 'devices') as WorklistEntry[],
  });
  process.stdout.write(formatRefreshSummaryMarkdown(summary));
  return 0;
}

/**
 * TASKS T3.8 — reconciles MAME against four independent board↔chipset witnesses.
 *
 * **Always exits 0 on a completed run, whatever it finds.** The report is advisory by
 * design (see `reconcile/report.ts`): two of the four witnesses are wikis, and a red build
 * caused by someone else's edit is an outage, not a quality gate. A malformed config or an
 * unreachable network is a different thing entirely and propagates as a stack trace.
 */
async function runReconcileCommand(): Promise<number> {
  const result = await runReconcile({ log: write });
  process.stdout.write(formatReportLog(result.report));
  write(`reconcile: wrote ${result.rawPath} (${result.rawBytes} bytes) and ${result.reportPath}`);
  write(
    `reconcile: ${result.networkRequests} network request(s), ${result.cacheHits} cache hit(s)`,
  );
  return 0;
}

/**
 * TASKS T3.8 — fails when anything in the tree fetches a host `forbidden_hosts` names,
 * while allowing the same host as a citation in a curated row file and as prose.
 *
 * This one *does* exit non-zero, and it is the only part of T3.8 that gates CI: the rule it
 * enforces is a constraint the source's owner set, not a quality opinion of ours.
 */
function runReconcileGuard(argv: readonly string[]): number {
  const [root] = argv;
  const config = loadReconcileConfig();
  const result = runGuard(
    config.forbiddenHosts,
    config.guard,
    ...(root === undefined ? [] : ([root] as const)),
  );
  process.stdout.write(formatGuardReport(result, config.forbiddenHosts));
  return result.violations.length > 0 ? 1 : 0;
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!isCommand(command)) {
    process.stderr.write(`usage: pipeline <${COMMANDS.join('|')}>\n`);
    return command === undefined ? 1 : 2;
  }
  switch (command) {
    case 'validate':
      return runValidate(rest);
    case 'mame:fetch':
      return runMameFetch();
    case 'mame:extract':
      return runMameExtract();
    case 'mame:rows':
      return runMameRows();
    case 'mame:bump-pin':
      return runMameBumpPin(rest);
    case 'mame:refresh-summary':
      return runMameRefreshSummary(rest);
    case 'build':
      return runBuild(rest);
    case 'prospector':
      return runProspector(rest);
    case 'reconcile':
      return runReconcileCommand();
    case 'reconcile:guard':
      return runReconcileGuard(rest);
    default:
      return 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
