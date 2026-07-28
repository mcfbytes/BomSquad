/**
 * `pipeline mame:extract` — the whole of Phase 2, composed.
 *
 * Fetch (T2.1) → stream-parse (T2.2) → filter (T2.3) → worklist (T2.4), then verify the
 * result against the real DDL and write two files:
 *
 * - `extract/machines.raw.json` — every machine that survived the filter, with its
 *   devices. The input to T6.1's `machine` / `machine_chip` / `machine_unmapped_device`
 *   row files.
 * - `extract/mame-devices.raw.json` — the Phase 3 curation worklist.
 *
 * **One pass, and where the memory actually goes.** The 309 MB document is never held:
 * {@link parseMachines} hands over one machine at a time and this function keeps only the
 * ones the filter accepts (9,775 of 50,097 in 0.288) plus a clone counter. Peak RSS is
 * therefore a property of MAME's *machine count*, not of its XML size — measured at 323 MB
 * against the 1 GB budget in TASKS T2.2, and it does not grow when MAME's ROM listings do.
 *
 * **The header of each file is a provenance record, not decoration.** It names the MAME
 * release, the archive's verified SHA-256 and the config version that produced the file,
 * so a committed extract can be traced to its inputs without a build log. It contains no
 * timestamp and no host detail — anything varying run to run would break the byte-identical
 * guarantee that is standing rule 2.
 */
import { hrtime, memoryUsage } from 'node:process';
import { join } from 'node:path';

import {
  EXTRACT_DIR,
  loadExtractConfig,
  loadMameConfig,
  type ExtractConfig,
  type KnownViolation,
  type MameConfig,
} from './config.js';
import { fetchListxml } from './fetch.js';
import { openZipEntry, readCentralDirectory, soleXmlEntry } from './zip.js';
import { parseMachines, type ParseStats } from './parse.js';
import { createFilter, DROP_REASONS, type FilterStats } from './filter.js';
import { buildWorklist, type WorklistEntry } from './worklist.js';
import { compareBytes } from '../db/rowfiles.js';
import { verifyAgainstSchema, type SchemaViolation } from './verify.js';
import { writeRecordArrayFile } from './json.js';

export const MACHINES_FILE = 'machines.raw.json';
export const DEVICES_FILE = 'mame-devices.raw.json';

export interface ExtractionOptions {
  readonly mame?: MameConfig;
  readonly extract?: ExtractConfig;
  /** Where the two `*.raw.json` files go. Defaults to `extract/` at the repository root. */
  readonly outputDir?: string;
  readonly cacheDir?: string;
  readonly log?: (line: string) => void;
}

/** Whether a DDL refusal was already acknowledged in `config/mame-extract.json`. */
export interface VerificationResult {
  /** Refusals the config does not list. Any of these fails the run. */
  readonly unexpected: readonly SchemaViolation[];
  /** Refusals listed in `known_schema_violations`, with the reason given for each. */
  readonly known: readonly (SchemaViolation & { readonly reason: string })[];
  /** Exact refusal count per table, uncapped. */
  readonly counts: ReadonlyMap<string, number>;
  /** Acknowledged violations that did not occur — the DDL or MAME has moved on. */
  readonly unusedKnown: readonly string[];
}

export interface ExtractionResult {
  readonly mame: MameConfig;
  readonly parse: ParseStats;
  readonly filter: FilterStats;
  readonly worklist: readonly WorklistEntry[];
  readonly verification: VerificationResult;
  readonly machinesPath: string;
  readonly machinesBytes: number;
  readonly devicesPath: string;
  readonly devicesBytes: number;
  /** Peak `rss` sampled around the parse, in bytes. Reported so the budget is observable. */
  readonly peakRssBytes: number;
  readonly wallClockMs: number;
}

/**
 * Runs the extraction end to end.
 *
 * Every output-bearing step is a pure function tested on its own; this composes them and
 * owns exactly the I/O — which is why it has no logic a golden fixture would want to
 * exercise, and why the fixtures drive `parseMachinesFromString`, `applyFilter` and
 * `buildWorklist` directly instead.
 */
export async function runExtraction(options: ExtractionOptions = {}): Promise<ExtractionResult> {
  const started = hrtime.bigint();
  const log = options.log ?? ((): void => undefined);
  const mame = options.mame ?? loadMameConfig();
  const config = options.extract ?? loadExtractConfig();
  const outputDir = options.outputDir ?? EXTRACT_DIR;

  const fetched = await fetchListxml(mame, {
    ...(options.cacheDir !== undefined ? { cacheDir: options.cacheDir } : {}),
    log,
  });
  const entry = soleXmlEntry(await readCentralDirectory(fetched.archivePath));
  log(`mame:extract: parsing ${entry.name} (${entry.uncompressedSize} bytes uncompressed)`);

  let peakRssBytes = memoryUsage.rss();
  let seen = 0;
  // The filter consumes machines as they are parsed, so a dropped machine and its device
  // list become garbage immediately instead of being collected and discarded later.
  const filter = createFilter(config.filter);
  const stream = await openZipEntry(fetched.archivePath, entry);
  const parse = await parseMachines(stream, (machine) => {
    filter.add(machine);
    // Sampling here rather than on a timer costs one syscall per 4096 machines. It is a
    // measurement, never written to a file, so it cannot make a build non-deterministic.
    seen += 1;
    if (seen % 4096 === 0) peakRssBytes = Math.max(peakRssBytes, memoryUsage.rss());
  });
  peakRssBytes = Math.max(peakRssBytes, memoryUsage.rss());

  const filtered = filter.finish();
  const worklist = buildWorklist(filtered.machines, config.worklist.sampleMachineIds);
  const verification = classifyViolations(
    verifyAgainstSchema(filtered.machines),
    config.knownSchemaViolations,
  );

  const provenance = {
    mame_release: mame.release,
    mame_version: mame.version,
    mame_build: parse.build,
    listxml_sha256: fetched.sha256,
    extract_config_version: config.version,
  } as const;

  const machinesPath = join(outputDir, MACHINES_FILE);
  const machinesBytes = writeRecordArrayFile(
    machinesPath,
    { ...provenance, machine_count: filtered.machines.length },
    'machines',
    filtered.machines,
  );
  const devicesPath = join(outputDir, DEVICES_FILE);
  const devicesBytes = writeRecordArrayFile(
    devicesPath,
    { ...provenance, device_count: worklist.length },
    'devices',
    worklist,
  );

  return {
    mame,
    parse,
    filter: filtered.stats,
    worklist,
    verification,
    machinesPath,
    machinesBytes,
    devicesPath,
    devicesBytes,
    peakRssBytes,
    wallClockMs: Number((hrtime.bigint() - started) / 1_000_000n),
  };
}

/**
 * Splits DDL refusals into acknowledged and unexpected.
 *
 * The exact `counts` decide, not the detail list: `verifyAgainstSchema` caps how many
 * refusals it details per table, so a refusal beyond the cap has no detail to match a
 * known-violation key and is therefore counted as unexpected. Capping can only make the
 * run fail harder, never quieter.
 */
export function classifyViolations(
  result: ReturnType<typeof verifyAgainstSchema>,
  known: readonly KnownViolation[],
): VerificationResult {
  const reasons = new Map(known.map((entry) => [entry.key, entry.reason]));
  const matched = new Set<string>();
  const acknowledged: (SchemaViolation & { readonly reason: string })[] = [];
  const unexpected: SchemaViolation[] = [];

  for (const violation of result.violations) {
    const key = `${violation.table}/${violation.machineId}`;
    const reason = reasons.get(key);
    if (reason === undefined) {
      unexpected.push(violation);
      continue;
    }
    matched.add(key);
    acknowledged.push({ ...violation, reason });
  }

  // Any refusal the cap swallowed is unaccounted for and must fail the run. There is no
  // detail to report for it, so it is represented by the table it happened in.
  let total = 0;
  for (const count of result.counts.values()) total += count;
  const detailed = result.violations.length;
  for (let index = 0; index < total - detailed; index += 1) {
    unexpected.push({
      table: '(undetailed)',
      machineId: '?',
      detail: 'refused, beyond the per-table detail cap',
    });
  }

  return {
    unexpected,
    known: acknowledged,
    counts: result.counts,
    unusedKnown: known
      .filter((entry) => !matched.has(entry.key))
      .map((entry) => entry.key)
      .sort(compareBytes),
  };
}

function mib(bytes: number): string {
  return `${(bytes / (1 << 20)).toFixed(1)} MiB`;
}

/**
 * The run log: kept and dropped counts by reason, accounting for every machine.
 *
 * The arithmetic line is not a nicety. TASKS T2.3's acceptance criterion is that the log
 * accounts for **every** dropped machine, and the only way to show that is to print the
 * sum next to the total and let them be compared.
 */
export function formatExtractionLog(result: ExtractionResult, topDevices = 15): string {
  const lines: string[] = [];
  const { filter } = result;
  let droppedTotal = 0;
  for (const count of filter.dropped.values()) droppedTotal += count;

  lines.push(`MAME ${result.mame.version} (${result.parse.build || 'build unknown'})`);
  lines.push(
    `  parsed          ${result.parse.machines} machines, ${result.parse.chips} <chip>, ` +
      `${result.parse.deviceRefs} <device_ref>`,
  );
  lines.push(`  kept            ${filter.kept}`);
  for (const reason of DROP_REASONS) {
    lines.push(`  dropped ${reason.padEnd(15)} ${filter.dropped.get(reason) ?? 0}`);
  }
  lines.push(
    `  accounted for   ${filter.kept} kept + ${droppedTotal} dropped = ` +
      `${filter.kept + droppedTotal} of ${filter.total} parsed` +
      (filter.kept + droppedTotal === filter.total ? '' : '  ** MISMATCH **'),
  );

  if (filter.excludedByRule.size > 0) {
    lines.push('  excluded drivers (machines dropped by each exclude_sourcefile entry):');
    for (const [pattern, count] of [...filter.excludedByRule].sort((a, b) => b[1] - a[1])) {
      lines.push(`    ${String(count).padStart(6)}  ${pattern}`);
    }
  }
  if (filter.unusedExcludeRules.length > 0) {
    lines.push(
      `  exclude_sourcefile entries that matched nothing: ${filter.unusedExcludeRules.join(', ')}`,
    );
  }
  if (filter.unusedKeepRules.length > 0) {
    lines.push(
      `  keep_sourcefile entries that matched nothing: ${filter.unusedKeepRules.join(', ')}`,
    );
  }

  const entryLine = (entry: WorklistEntry): string =>
    `    ${String(entry.instance_count).padStart(6)} x ${entry.mame_device.padEnd(24)} ` +
    `in ${String(entry.machine_count).padStart(5)} machines  ${(entry.chip_names ?? []).join(' / ')}`;

  lines.push(`  devices         ${result.worklist.length} distinct across kept machines`);
  lines.push('  highest impact overall (the curation order — an ignore_reason counts too):');
  for (const entry of result.worklist.slice(0, topDevices)) lines.push(entryLine(entry));
  // The same list restricted to devices MAME itself calls a chip. This is TASKS T2.4's
  // sanity check ("z80, m68000, ym2151-class devices dominate"), which the unrestricted
  // list cannot show: MAME's highest-impact device references are screens, palettes and
  // gfxdecodes, and those are real worklist entries — they are what `ignore_reason`
  // exists for — but they are not chips and pretending otherwise would hide a regression.
  lines.push('  highest impact among devices MAME classifies as a <chip>:');
  for (const entry of result.worklist
    .filter((entry) => entry.chip_types !== undefined)
    .slice(0, topDevices)) {
    lines.push(entryLine(entry));
  }

  if (result.parse.chipsWithoutDeviceRef > 0) {
    lines.push(
      `  NOTE  across all ${result.parse.machines} parsed machines (not only the kept ones), ` +
        `${result.parse.chipsWithoutDeviceRef} <chip> elements had no <device_ref> with the same ` +
        'tag and so carry no short name to record them under; they were dropped (see parse.ts).',
    );
  }
  if (result.parse.untaggedReferences > 0) {
    lines.push(`  NOTE  ${result.parse.untaggedReferences} device references had no usable tag.`);
  }

  const { verification } = result;
  if (verification.counts.size === 0) {
    lines.push('  schema          every extracted row inserts into schemas/schema.sql');
  } else {
    for (const [table, count] of verification.counts) {
      lines.push(`  schema          ${count} row(s) refused by ${table}`);
    }
  }
  if (verification.known.length > 0) {
    lines.push(
      `  schema          ${verification.known.length} refusal(s) acknowledged in ` +
        'config/mame-extract.json — a known DDL defect, not bad data:',
    );
    for (const violation of verification.known) {
      lines.push(`      ${violation.table}/${violation.machineId}: ${violation.reason}`);
    }
  }
  if (verification.unusedKnown.length > 0) {
    lines.push(
      '  schema          known_schema_violations entries that did not occur — delete them: ' +
        verification.unusedKnown.join(', '),
    );
  }
  if (verification.unexpected.length > 0) {
    lines.push('  schema          UNEXPECTED REFUSALS — T6.1 cannot emit these rows:');
    for (const violation of verification.unexpected) {
      lines.push(`      ${violation.table} ${violation.machineId}: ${violation.detail}`);
    }
  }

  lines.push(`  wrote           ${result.machinesPath} (${mib(result.machinesBytes)})`);
  lines.push(`  wrote           ${result.devicesPath} (${mib(result.devicesBytes)})`);
  lines.push(
    `  peak rss        ${mib(result.peakRssBytes)} · wall clock ${(result.wallClockMs / 1000).toFixed(1)}s`,
  );
  return `${lines.join('\n')}\n`;
}
