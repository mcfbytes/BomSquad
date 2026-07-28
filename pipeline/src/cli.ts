#!/usr/bin/env node
/**
 * BOM Squad pipeline CLI. Subcommands are pure functions of their inputs so runs are
 * reproducible.
 *
 *   pipeline validate [--strict] [--json]
 *   pipeline mame:fetch
 *   pipeline mame:extract
 *
 * Exit codes: 0 clean (or warnings only), 1 at least one ERROR (or any WARN under
 * `--strict`), 2 bad usage.
 */
import { failed, formatJson, formatReport, type ReportOptions } from './validate/report.js';
import { validate } from './validate/index.js';
import { formatExtractionLog, runExtraction } from './mame/extract.js';
import { fetchListxml } from './mame/fetch.js';
import { loadMameConfig } from './mame/config.js';

const COMMANDS = ['validate', 'mame:fetch', 'mame:extract'] as const;
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
    default:
      return 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
