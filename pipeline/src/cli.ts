#!/usr/bin/env node
/**
 * BOM Squad pipeline CLI. Subcommands are pure functions of their inputs so runs are
 * reproducible.
 *
 *   pipeline validate [--strict] [--json]
 *
 * Exit codes: 0 clean (or warnings only), 1 at least one ERROR (or any WARN under
 * `--strict`), 2 bad usage.
 */
import { failed, formatJson, formatReport, type ReportOptions } from './validate/report.js';
import { validate } from './validate/index.js';

const COMMANDS = ['validate', 'mame:fetch'] as const;
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

function main(argv: readonly string[]): number {
  const [command, ...rest] = argv;
  if (!isCommand(command)) {
    process.stderr.write(`usage: pipeline <${COMMANDS.join('|')}>\n`);
    return command === undefined ? 1 : 2;
  }
  if (command === 'validate') return runValidate(rest);
  process.stdout.write(`pipeline: '${command}' is not implemented yet\n`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
