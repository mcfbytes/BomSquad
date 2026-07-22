#!/usr/bin/env node
/**
 * BOM Squad pipeline CLI. Subcommands are registered in src/commands/ and wired
 * here; each is a pure function of its inputs so runs are reproducible.
 */
const COMMANDS = ['validate', 'mame:fetch'] as const;
type Command = (typeof COMMANDS)[number];

function isCommand(value: string | undefined): value is Command {
  return COMMANDS.includes(value as Command);
}

function main(argv: readonly string[]): number {
  const [command] = argv;
  if (!isCommand(command)) {
    process.stderr.write(`usage: pipeline <${COMMANDS.join('|')}>\n`);
    return command === undefined ? 1 : 2;
  }
  process.stdout.write(`pipeline: '${command}' is not implemented yet\n`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
