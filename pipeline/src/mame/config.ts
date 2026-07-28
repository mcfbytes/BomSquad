/**
 * The two MAME extraction config files, read and checked once.
 *
 * There are exactly two, and the split is deliberate:
 *
 * - **`config/mame.json`** is the *pin*. Which MAME release this dataset is built from
 *   lives here and nowhere else, so bumping MAME is one file and one review. Nothing in
 *   `src/` names a release, a version or an asset filename.
 * - **`config/mame-extract.json`** is the *policy*: which machines survive the filter and
 *   how the device worklist is sized. It changes on a curation decision, not a release.
 *
 * Both are plain JSON with no comments, matching `config/quality-thresholds.json`, and
 * both are validated here rather than at the point of use: a typo in a pin should fail
 * before a 20 MB download, not after a 300 MB parse.
 *
 * The reason strings in `exclude_sourcefile` are not decoration. MAME's XML carries no
 * genre field (see `limitations` in the file itself and `extract/README.md`), so every
 * exclusion is a human judgement about a driver, and standing rule 3 says a judgement
 * that cannot be checked does not belong in the dataset. Requiring a non-empty reason per
 * entry makes the list self-documenting and makes an unexplained exclusion a load error.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { compareBytes } from '../db/rowfiles.js';

/** Repository root, resolved from this module. `src/mame` and `dist/mame` are both three deep. */
export const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

export const CONFIG_DIR = join(REPO_ROOT, 'pipeline', 'config');
export const MAME_CONFIG_PATH = join(CONFIG_DIR, 'mame.json');
export const EXTRACT_CONFIG_PATH = join(CONFIG_DIR, 'mame-extract.json');

/** Where a verified listxml archive is cached. Gitignored; see `.gitignore`. */
export const CACHE_DIR = join(REPO_ROOT, '.cache', 'mame');

/** Where the generated extracts are written (data-model.md §4.2: `extract/` is generated). */
export const EXTRACT_DIR = join(REPO_ROOT, 'extract');

/** The pinned MAME release. */
export interface MameConfig {
  /** GitHub release tag, e.g. `mame0288`. */
  readonly release: string;
  /** MAME's own version string, e.g. `0.288`. Becomes `dataset_meta.mame_version` in T6.1. */
  readonly version: string;
  /** Release download root; the tag and asset name are appended. */
  readonly releaseBaseUrl: string;
  /** listxml archive asset, e.g. `mame0288lx.zip`. */
  readonly listxmlAsset: string;
  /** Checksum manifest asset published alongside it, e.g. `SHA256SUMS`. */
  readonly checksumsAsset: string;
}

/** One filter rule that fired, with the human reason the config gives for it. */
export interface SourcefileRule {
  /** Config key: an exact `dir/file.cpp`, or a `dir/` prefix matching every driver under it. */
  readonly pattern: string;
  readonly reason: string;
}

export interface FilterConfig {
  /** Drop `isdevice="yes"` machines: they are MAME device models, not hardware anyone plays. */
  readonly dropDevices: boolean;
  /** Drop `ismechanical="yes"` machines: pinball, redemption and slot cabinets. */
  readonly dropMechanical: boolean;
  /** Keep only parents; a clone's existence is recorded as `clone_count` on its parent. */
  readonly parentsOnly: boolean;
  /** Drop `isbios="yes"` machines. Off by default: a BIOS set is real hardware with a real BOM. */
  readonly dropBios: boolean;
  /** Gambling / fruit-machine drivers, bytewise sorted by pattern. */
  readonly excludeSourcefile: readonly SourcefileRule[];
  /** Exact driver paths that win over an `excludeSourcefile` prefix, bytewise sorted. */
  readonly keepSourcefile: readonly SourcefileRule[];
}

export interface WorklistConfig {
  /** How many machine ids to sample per device. Bounded so the worklist stays reviewable. */
  readonly sampleMachineIds: number;
}

/**
 * A row `schemas/schema.sql` refuses today, acknowledged so the build stays green while
 * *new* refusals still fail it.
 *
 * This exists because the extract is verified by being inserted into the real DDL
 * (`mame/verify.ts`), and a disagreement between MAME's data and the DDL is not always the
 * data's fault. MAME 0.288 ships driver paths containing hyphens; the `sourcefile` grammar
 * of docs/data-model.md §3.2 does not admit one. Dropping those machines would be data
 * loss caused by a schema defect, and failing every build until the schema is fixed helps
 * nobody — so each is listed here, by key, with the reason, and the moment the DDL is
 * corrected the entry becomes *unused* and is reported as such.
 *
 * It is not a mute button. Anything not listed here fails the run.
 */
export interface KnownViolation {
  /** `<table>/<machine_id>`, e.g. `machine/racingj`. */
  readonly key: string;
  readonly reason: string;
}

export interface ExtractConfig {
  readonly version: string;
  readonly filter: FilterConfig;
  readonly worklist: WorklistConfig;
  readonly knownSchemaViolations: readonly KnownViolation[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJson(path: string): Record<string, unknown> {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isPlainObject(raw)) throw new Error(`${path}: expected a JSON object`);
  return raw;
}

function requireString(source: Record<string, unknown>, key: string, path: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${path}: '${key}' must be a non-empty string`);
  }
  return value;
}

function requireBoolean(source: Record<string, unknown>, key: string, path: string): boolean {
  const value = source[key];
  if (typeof value !== 'boolean') throw new Error(`${path}: '${key}' must be true or false`);
  return value;
}

function requireObject(
  source: Record<string, unknown>,
  key: string,
  path: string,
): Record<string, unknown> {
  const value = source[key];
  if (!isPlainObject(value)) throw new Error(`${path}: '${key}' must be an object`);
  return value;
}

/**
 * A `pattern: reason` map, bytewise sorted by pattern. Sorting here rather than at the
 * point of use means no caller can leak the config file's key order into an output.
 */
function readRules(
  source: Record<string, unknown>,
  key: string,
  path: string,
): readonly SourcefileRule[] {
  const rules: SourcefileRule[] = [];
  for (const [pattern, reason] of Object.entries(requireObject(source, key, path))) {
    if (typeof reason !== 'string' || reason.trim() === '') {
      throw new Error(
        `${path}: ${key}['${pattern}'] must be a non-empty reason — MAME publishes no genre ` +
          'field, so every driver exclusion is a human judgement and has to say why.',
      );
    }
    rules.push({ pattern, reason });
  }
  return rules.sort((a, b) => compareBytes(a.pattern, b.pattern));
}

/** `mame0288` → `0.288`: the digits of the tag, the first one being the major component. */
function versionFromRelease(release: string): string | undefined {
  const digits = /^mame(\d)(\d+)$/.exec(release);
  return digits === null ? undefined : `${digits[1] ?? ''}.${digits[2] ?? ''}`;
}

/**
 * Reads and cross-checks the pin. The three release-bearing fields are stated rather than
 * derived — a silent derivation is exactly the kind of thing that keeps "working" after
 * MAME changes an asset name — but they must agree, so a half-edited pin (tag bumped,
 * asset filename forgotten) fails here instead of downloading last month's XML under this
 * month's version number.
 */
export function loadMameConfig(path: string = MAME_CONFIG_PATH): MameConfig {
  const raw = readJson(path);
  const config: MameConfig = {
    release: requireString(raw, 'release', path),
    version: requireString(raw, 'version', path),
    releaseBaseUrl: requireString(raw, 'release_base_url', path),
    listxmlAsset: requireString(raw, 'listxml_asset', path),
    checksumsAsset: requireString(raw, 'checksums_asset', path),
  };
  if (!/^mame\d+$/.test(config.release)) {
    throw new Error(`${path}: 'release' must look like 'mame0288', got '${config.release}'`);
  }
  const expected = versionFromRelease(config.release);
  if (expected !== config.version) {
    throw new Error(
      `${path}: 'version' is '${config.version}' but release '${config.release}' means ` +
        `'${String(expected)}'. Bump both or neither.`,
    );
  }
  if (!config.listxmlAsset.startsWith(config.release)) {
    throw new Error(
      `${path}: 'listxml_asset' is '${config.listxmlAsset}', which is not an asset of release ` +
        `'${config.release}'. Bump both or neither.`,
    );
  }
  if (!config.releaseBaseUrl.startsWith('https://')) {
    throw new Error(`${path}: 'release_base_url' must be https`);
  }
  return config;
}

/** Reads the extraction policy. */
export function loadExtractConfig(path: string = EXTRACT_CONFIG_PATH): ExtractConfig {
  const raw = readJson(path);
  const filter = requireObject(raw, 'filter', path);
  const worklist = requireObject(raw, 'worklist', path);
  const sample = worklist['sample_machine_ids'];
  if (typeof sample !== 'number' || !Number.isInteger(sample) || sample < 1) {
    throw new Error(`${path}: worklist.sample_machine_ids must be a positive integer`);
  }
  const excludeSourcefile = readRules(filter, 'exclude_sourcefile', path);
  const keepSourcefile = readRules(filter, 'keep_sourcefile', path);
  const excluded = new Set(excludeSourcefile.map((rule) => rule.pattern));
  for (const rule of keepSourcefile) {
    if (excluded.has(rule.pattern)) {
      throw new Error(
        `${path}: '${rule.pattern}' is in both keep_sourcefile and exclude_sourcefile. ` +
          'A keep entry names an exception *inside* an excluded directory prefix, not a ' +
          'contradiction of an exact exclusion.',
      );
    }
  }
  return {
    version: requireString(raw, 'version', path),
    filter: {
      dropDevices: requireBoolean(filter, 'drop_devices', path),
      dropMechanical: requireBoolean(filter, 'drop_mechanical', path),
      parentsOnly: requireBoolean(filter, 'parents_only', path),
      dropBios: requireBoolean(filter, 'drop_bios', path),
      excludeSourcefile,
      keepSourcefile,
    },
    worklist: { sampleMachineIds: sample },
    knownSchemaViolations: readRules(raw, 'known_schema_violations', path).map((rule) => ({
      key: rule.pattern,
      reason: rule.reason,
    })),
  };
}
