#!/usr/bin/env node
/**
 * BOM Squad pipeline CLI. Subcommands are pure functions of their inputs so runs are
 * reproducible.
 *
 *   pipeline validate [--strict] [--json]
 *   pipeline mame:fetch
 *   pipeline mame:extract
 *   pipeline mame:bump-pin <release-tag>
 *   pipeline mame:refresh-summary <old-extract-dir> <new-extract-dir>
 *
 * Exit codes: 0 clean (or warnings only), 1 at least one ERROR (or any WARN under
 * `--strict`), 2 bad usage.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
import type { RawMachine } from './mame/parse.js';
import type { WorklistEntry } from './mame/worklist.js';

const COMMANDS = [
  'validate',
  'mame:fetch',
  'mame:extract',
  'mame:bump-pin',
  'mame:refresh-summary',
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
    case 'mame:bump-pin':
      return runMameBumpPin(rest);
    case 'mame:refresh-summary':
      return runMameRefreshSummary(rest);
    default:
      return 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
