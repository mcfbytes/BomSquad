/**
 * `pipeline reconcile` — TASKS T3.8, the independent board↔chipset witness.
 *
 * MAME is currently the only witness to the board→chip half of the join, and a single
 * source cannot disagree with itself. Nothing in the dataset can presently detect a MAME
 * abstraction, a mis-attributed custom part, or a curated `system_chip` BOM that has
 * drifted; a part MAME models inside driver code rather than as a device is not merely
 * missing, it is *invisible* — it is not counted as unmapped, so the system carrying it
 * scores as better covered than it is. This command adds four independent witnesses and
 * reconciles them against MAME.
 *
 * The four are chosen for their **terms**, not their convenience: MAME's own driver sources
 * (BSD-3-Clause/GPL-2.0), Wikidata (CC0), English Wikipedia (CC-BY-SA-4.0, matching
 * `LICENSE-DATA`) and jotego/jtcores (GPL). system16.com, which the maintainer asked about
 * by name, is **not** among them and cannot be: its `robots.txt` disallows this user agent
 * outright and its origin refuses non-browser clients. It remains a legitimate
 * human-directed reference — a curator may read a page and cite it as a `source_url` on a
 * row they author by hand — and `reconcile:guard` is what keeps the distinction honest.
 *
 * ## Two artefacts
 *
 * - **`extract/reconciliation.raw.json`** — per system, the chip set each witness asserts,
 *   with a citation per part. Committed, so a PR shows what a witness moved.
 * - **`dist/reconciliation-report.json`** — the diff, every part classified `agreed` /
 *   `mame-only` / `reference-only`. Advisory, never a build failure, and never written to
 *   `data/`: a disagreement is a curation prompt resolved by a human authoring a row with a
 *   citation, exactly like T3.1's device worklist.
 *
 * ## Determinism
 *
 * Every response is cached under `.cache/reconcile/` by request hash, so a second run
 * issues no network request and produces byte-identical output. Neither artefact contains a
 * timestamp, a host path or a wall-clock reading — the Wikipedia citations are `oldid`
 * permalinks and the jtcores citations name a pinned commit, so the *evidence* is pinned
 * too, not just the run.
 */
import { join } from 'node:path';

import { compareBytes } from '../db/rowfiles.js';
import { DIST_DIR, EXTRACT_DIR } from '../build/index.js';
import { loadMameConfig } from '../mame/config.js';
import { writeRecordArrayFile } from '../mame/json.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  loadReconcileBindings,
  loadReconcileConfig,
  RECONCILE_RAW_FILE,
  RECONCILE_REPORT_FILE,
  type ReconcileBindings,
  type ReconcileConfig,
} from './config.js';
import { ReconcileFetcher } from './http.js';
import { loadDataset, mameListxmlWitness, readMameVersion } from './dataset.js';
import { mameSourceWitness } from './mame-source.js';
import { wikidataWitness } from './wikidata.js';
import { wikipediaWitness } from './wikipedia.js';
import { jtcoresWitness } from './jtcores.js';
import { buildReport, formatReportJson, type ReconciliationReport } from './report.js';
import {
  WITNESS_IDS,
  type SystemWitnesses,
  type WitnessId,
  type WitnessRecord,
} from './witness.js';

export const GENERATOR = 'pipeline reconcile';

export interface ReconcileOptions {
  readonly config?: ReconcileConfig;
  readonly bindings?: ReconcileBindings;
  readonly extractDir?: string;
  readonly outputDir?: string;
  readonly cacheDir?: string;
  readonly log?: (line: string) => void;
}

export interface ReconcileResult {
  readonly report: ReconciliationReport;
  readonly rawPath: string;
  readonly reportPath: string;
  readonly rawBytes: number;
  readonly networkRequests: number;
  readonly cacheHits: number;
}

/**
 * Merges the five per-witness maps into one record per system.
 *
 * A system with no witness at all is dropped rather than emitted empty: `system` rows exist
 * for boards MAME has no machines for, and a record asserting nothing is noise in a file
 * whose whole purpose is disagreement.
 */
export function mergeWitnesses(
  witnesses: ReadonlyMap<WitnessId, ReadonlyMap<string, WitnessRecord>>,
): SystemWitnesses[] {
  const systemIds = new Set<string>();
  for (const perSystem of witnesses.values()) {
    for (const systemId of perSystem.keys()) systemIds.add(systemId);
  }
  return [...systemIds]
    .sort(compareBytes)
    .map((systemId) => ({
      system_id: systemId,
      witnesses: WITNESS_IDS.flatMap((witness) => witnesses.get(witness)?.get(systemId) ?? []),
    }))
    .filter((system) => system.witnesses.length > 0);
}

/** Runs every enabled witness, writes both artefacts, and returns the report. */
export async function runReconcile(options: ReconcileOptions = {}): Promise<ReconcileResult> {
  const log = options.log ?? ((): void => undefined);
  const config = options.config ?? loadReconcileConfig();
  const bindings = options.bindings ?? loadReconcileBindings();
  const extractDir = options.extractDir ?? EXTRACT_DIR;
  const outputDir = options.outputDir ?? DIST_DIR;

  const mameConfig = loadMameConfig();
  const mameVersion = readMameVersion(extractDir) ?? mameConfig.version;
  const dataset = loadDataset(config.recognition);
  log(
    `reconcile: ${dataset.systems.length} systems, ` +
      `${dataset.machinesBySystem.size} of them with machines from MAME ${mameVersion}`,
  );

  const fetcher = new ReconcileFetcher(config, {
    ...(options.cacheDir !== undefined ? { cacheDir: options.cacheDir } : {}),
    log,
  });

  const systemOfMachine = new Map<string, string>();
  for (const [systemId, machineIds] of dataset.machinesBySystem) {
    for (const machineId of machineIds) systemOfMachine.set(machineId, systemId);
  }

  const witnesses = new Map<WitnessId, ReadonlyMap<string, WitnessRecord>>();
  witnesses.set(
    'mame-listxml',
    mameListxmlWitness(dataset, mameConfig.release, config.recognition),
  );

  if (config.mameSource.enabled) {
    witnesses.set(
      'mame-source',
      await mameSourceWitness(
        fetcher,
        config.mameSource,
        mameConfig.release,
        dataset.sourcefilesBySystem,
        dataset.declaredSystemsBySourcefile,
        systemOfMachine,
        config.recognition,
        dataset.chipIndex,
        log,
      ),
    );
  }
  if (config.wikidata.enabled) {
    witnesses.set(
      'wikidata',
      await wikidataWitness(
        fetcher,
        config.wikidata,
        bindings.systems,
        config.recognition,
        dataset.chipIndex,
        log,
      ),
    );
  }
  if (config.wikipedia.enabled) {
    witnesses.set(
      'wikipedia',
      await wikipediaWitness(
        fetcher,
        config.wikipedia,
        bindings.systems,
        config.recognition,
        dataset.chipIndex,
        log,
      ),
    );
  }
  if (config.jtcores.enabled) {
    witnesses.set(
      'jtcores',
      await jtcoresWitness(
        fetcher,
        config.jtcores,
        bindings.jtModules,
        bindings.systems,
        config.recognition,
        dataset.chipIndex,
        log,
      ),
    );
  }

  const systems = mergeWitnesses(witnesses);
  const machineCounts = new Map(
    [...dataset.machinesBySystem].map(([systemId, machines]) => [systemId, machines.length]),
  );
  const report = buildReport(systems, machineCounts, {
    mameVersion,
    mameRelease: mameConfig.release,
    generator: GENERATOR,
  });

  const rawPath = join(extractDir, RECONCILE_RAW_FILE);
  const rawBytes = writeRecordArrayFile(
    rawPath,
    {
      generator: GENERATOR,
      mame_version: mameVersion,
      mame_release: mameConfig.release,
      jtcores_commit: config.jtcores.commit,
      system_count: systems.length,
    },
    'systems',
    systems,
  );

  const reportPath = join(outputDir, RECONCILE_REPORT_FILE);
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(reportPath, formatReportJson(report));

  return {
    report,
    rawPath,
    reportPath,
    rawBytes,
    networkRequests: fetcher.stats.networkRequests,
    cacheHits: fetcher.stats.cacheHits,
  };
}
