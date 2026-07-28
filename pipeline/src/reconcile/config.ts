/**
 * The two `pipeline reconcile` config files, read and checked once.
 *
 * The split mirrors `mame/config.ts`'s, and for the same reason:
 *
 * - **`config/reconcile.json`** is the *engine*: which hosts may never be fetched, how
 *   hard the fetcher is allowed to push, the grammar of a part designation, and the rules
 *   the `system16.com` CI guard applies. It changes when the machinery changes.
 * - **`config/reconcile-systems.json`** is the *binding*: which Wikidata item, which
 *   Wikipedia article and which jtcores core speak for a given `system_id`, and which real
 *   part each jotego module implements. It changes when a curator finds another witness.
 *
 * Two rules in here are load-bearing and are enforced at load time rather than at the
 * point of use.
 *
 * **A forbidden host is a fact about the source, not a preference.** `forbidden_hosts` is
 * a `domain: reason` map and the reason may not be empty, exactly as `mame-extract.json`'s
 * `exclude_sourcefile` requires one: refusing to fetch something is a judgement, and a
 * judgement that cannot be checked does not belong in the dataset (standing rule 3). The
 * same list feeds two consumers that must never disagree — `reconcile/http.ts` refuses the
 * host at run time, and `reconcile/guard.ts` refuses it at review time — which is why it
 * is declared once, here, and derived nowhere.
 *
 * **A jt-module mapping is a claim about silicon.** `jt_modules` says "this Verilog module
 * implements this part"; every entry therefore carries a `note` giving the ground for it,
 * and a bare `module: "PART"` string is a load error. Most of the notes are one sentence
 * because most module names literally contain the part number — but the one that does not
 * (`jtpcm568` -> RF5C68) is exactly the entry a reader needs the note for.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { compareBytes } from '../db/rowfiles.js';
import { CONFIG_DIR, REPO_ROOT } from '../mame/config.js';

export const RECONCILE_CONFIG_PATH = join(CONFIG_DIR, 'reconcile.json');
export const RECONCILE_SYSTEMS_PATH = join(CONFIG_DIR, 'reconcile-systems.json');

/** Where reconciliation caches HTTP responses. Gitignored; see `.gitignore`. */
export const RECONCILE_CACHE_DIR = join(REPO_ROOT, '.cache', 'reconcile');

/** The per-system witness record. Committed, so a PR shows what each witness moved. */
export const RECONCILE_RAW_FILE = 'reconciliation.raw.json';

/** The advisory diff report. Written under `dist/`, so it is never committed. */
export const RECONCILE_REPORT_FILE = 'reconciliation-report.json';

/** A host no code in this repository may fetch, and the reason it may not. */
export interface ForbiddenHost {
  /** Registrable domain. A hostname matches if it equals this or ends in `.` + this. */
  readonly domain: string;
  readonly reason: string;
}

/** MAME's own driver sources, at the release the extraction is already pinned to. */
export interface MameSourceConfig {
  readonly enabled: boolean;
  /** `<raw>/<release>/<sourceRoot>/<sourcefile>` is fetched. */
  readonly rawBaseUrl: string;
  /** `<blob>/<release>/<sourceRoot>/<sourcefile>#L<n>` is what a curator is shown. */
  readonly blobBaseUrl: string;
  readonly sourceRoot: string;
}

export interface WikidataConfig {
  readonly enabled: boolean;
  readonly endpoint: string;
  readonly entityBaseUrl: string;
  /** Property id -> the role it asserts, e.g. `P880` -> `CPU`. Bytewise sorted. */
  readonly properties: readonly { readonly id: string; readonly role: string }[];
}

export interface WikipediaConfig {
  readonly enabled: boolean;
  readonly apiUrl: string;
  /** Prefix for a permanent `oldid` citation, so a finding cites the revision it read. */
  readonly permalinkBaseUrl: string;
  readonly titlesPerRequest: number;
  /** Infobox parameter names worth reading, lowercased. */
  readonly infoboxFields: readonly string[];
  /** Section headings whose body is a specifications list, lowercased. */
  readonly sectionHeadings: readonly string[];
}

export interface JtcoresConfig {
  readonly enabled: boolean;
  readonly repo: string;
  /** Pinned commit. Determinism: a moving `master` would make every run a new answer. */
  readonly commit: string;
  readonly treeApiUrl: string;
  readonly rawBaseUrl: string;
  readonly blobBaseUrl: string;
  /** Which `cores/<core>/hdl/*` files carry instantiations worth reading. */
  readonly hdlSuffixes: readonly string[];
  /** Per-core dependency manifests, relative to `cores/<core>/`. */
  readonly configFiles: readonly string[];
}

/** One custom-part grammar a manufacturer uses, with the reason it is worth matching. */
export interface PartPattern {
  readonly id: string;
  readonly pattern: string;
  /**
   * When true the match only counts on a line that also satisfies
   * {@link RecognitionConfig.contextPattern}. Every shipped pattern sets this: `315-5197`
   * on its own is as likely to be a ROM label as a part, but `315-5197 - Custom Sega IC
   * Tilemap Generator (PGA135)` is unambiguous, and the difference is one word on the line.
   */
  readonly requiresContext: boolean;
  readonly note: string;
}

export interface RecognitionConfig {
  readonly contextPattern: string;
  /** Uppercased manufacturer words stripped from the front of a designation. */
  readonly vendorPrefixes: readonly string[];
  readonly patterns: readonly PartPattern[];
  /** Normalised designation -> `chip_id`, for what normalisation alone cannot reach. */
  readonly partAliases: ReadonlyMap<string, string>;
  /** Normalised designations that are packages, buses or generic words, never parts. */
  readonly ignoredParts: ReadonlySet<string>;
  /** Catalogue names shorter than this are not searched for in free text. */
  readonly minCatalogLiteralLength: number;
}

export interface GuardConfig {
  readonly skipDirectories: readonly string[];
  readonly skipFiles: readonly string[];
  readonly maxFileBytes: number;
  /** Roots below which a `.json` file is a curated row file (data-model.md §4.1). */
  readonly rowFileRoots: readonly string[];
  /** Row-file keys whose *value* may carry the host: a citation is not a fetch. */
  readonly allowedRowKeys: readonly string[];
  readonly proseExtensions: readonly string[];
  /** Lowercased fragments that mean "this text retrieves something over the network". */
  readonly fetchVerbs: readonly string[];
  readonly fetchContextLines: number;
}

export interface ReconcileConfig {
  readonly version: string;
  readonly userAgent: string;
  readonly rateLimitMs: number;
  readonly maxResponseBytes: number;
  readonly forbiddenHosts: readonly ForbiddenHost[];
  readonly mameSource: MameSourceConfig;
  readonly wikidata: WikidataConfig;
  readonly wikipedia: WikipediaConfig;
  readonly jtcores: JtcoresConfig;
  readonly recognition: RecognitionConfig;
  readonly guard: GuardConfig;
}

/** Which external witness speaks for one system. Every field is optional; none is guessed. */
export interface SystemBinding {
  readonly systemId: string;
  /** Wikidata entity id, e.g. `Q1034233`. */
  readonly wikidata?: string;
  /** English Wikipedia article title, exactly as the API normalises it. */
  readonly wikipedia?: string;
  /** jtcores core directory names, bytewise sorted. */
  readonly jtcores: readonly string[];
}

/** What a jotego Verilog module implements, and why we believe that. */
export interface JtModule {
  readonly module: string;
  readonly part: string;
  readonly note: string;
}

export interface ReconcileBindings {
  readonly version: string;
  /** Bytewise sorted by `systemId`. */
  readonly systems: readonly SystemBinding[];
  /** Bytewise sorted by `module`. */
  readonly jtModules: readonly JtModule[];
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

function requirePositiveInteger(
  source: Record<string, unknown>,
  key: string,
  path: string,
): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${path}: '${key}' must be a positive integer`);
  }
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

/** A `string[]`, bytewise sorted so no consumer can leak the file's element order. */
function requireStringArray(
  source: Record<string, unknown>,
  key: string,
  path: string,
): readonly string[] {
  const value = source[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${path}: '${key}' must be an array of strings`);
  }
  return [...(value as string[])].sort(compareBytes);
}

/**
 * A `key: reason` map where the reason may not be empty, bytewise sorted by key. Shared by
 * `forbidden_hosts` and by anything else that records a judgement rather than a setting.
 */
function readReasonMap(
  source: Record<string, unknown>,
  key: string,
  path: string,
  subject: string,
): readonly { readonly key: string; readonly reason: string }[] {
  const entries: { key: string; reason: string }[] = [];
  for (const [name, reason] of Object.entries(requireObject(source, key, path))) {
    if (typeof reason !== 'string' || reason.trim() === '') {
      throw new Error(
        `${path}: ${key}['${name}'] must be a non-empty reason — ${subject} is a judgement ` +
          'about a source, and a judgement that cannot be checked does not belong here.',
      );
    }
    entries.push({ key: name, reason });
  }
  return entries.sort((a, b) => compareBytes(a.key, b.key));
}

/** A `key: value` string map, bytewise sorted by key. */
function readStringMap(
  source: Record<string, unknown>,
  key: string,
  path: string,
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const [name, value] of Object.entries(requireObject(source, key, path))) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`${path}: ${key}['${name}'] must be a non-empty string`);
    }
    map.set(name, value);
  }
  return new Map([...map].sort((a, b) => compareBytes(a[0], b[0])));
}

function readPatterns(source: Record<string, unknown>, path: string): readonly PartPattern[] {
  const patterns: PartPattern[] = [];
  for (const [id, raw] of Object.entries(requireObject(source, 'patterns', path))) {
    if (!isPlainObject(raw)) throw new Error(`${path}: patterns['${id}'] must be an object`);
    const pattern = requireString(raw, 'pattern', `${path} patterns['${id}']`);
    try {
      // Compiled here so a bad grammar fails the load, not the first driver that hits it.
      new RegExp(pattern, 'gi');
    } catch (error) {
      throw new Error(`${path}: patterns['${id}'].pattern is not a valid regular expression`, {
        cause: error,
      });
    }
    patterns.push({
      id,
      pattern,
      requiresContext: requireBoolean(raw, 'requires_context', `${path} patterns['${id}']`),
      note: requireString(raw, 'note', `${path} patterns['${id}']`),
    });
  }
  return patterns.sort((a, b) => compareBytes(a.id, b.id));
}

/** Reads and cross-checks the engine config. */
export function loadReconcileConfig(path: string = RECONCILE_CONFIG_PATH): ReconcileConfig {
  const raw = readJson(path);
  const witnesses = requireObject(raw, 'witnesses', path);
  const mameSource = requireObject(witnesses, 'mame_source', path);
  const wikidata = requireObject(witnesses, 'wikidata', path);
  const wikipedia = requireObject(witnesses, 'wikipedia', path);
  const jtcores = requireObject(witnesses, 'jtcores', path);
  const recognition = requireObject(raw, 'recognition', path);
  const guard = requireObject(raw, 'guard', path);

  const forbiddenHosts = readReasonMap(
    raw,
    'forbidden_hosts',
    path,
    'refusing to fetch a host',
  ).map((entry) => ({ domain: entry.key.toLowerCase(), reason: entry.reason }));
  if (forbiddenHosts.length === 0) {
    throw new Error(
      `${path}: 'forbidden_hosts' is empty. It is the single declaration both the fetcher and ` +
        'the CI guard read; an empty one silently disables both.',
    );
  }

  const commit = requireString(jtcores, 'commit', path);
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(
      `${path}: witnesses.jtcores.commit must be a full 40-character SHA-1, got '${commit}'. ` +
        'A branch name is not a pin, and a run against a moving branch is not deterministic.',
    );
  }

  for (const url of [
    requireString(mameSource, 'raw_base_url', path),
    requireString(wikidata, 'endpoint', path),
    requireString(wikipedia, 'api_url', path),
    requireString(jtcores, 'raw_base_url', path),
  ]) {
    if (!url.startsWith('https://')) throw new Error(`${path}: '${url}' must be https`);
  }

  return {
    version: requireString(raw, 'version', path),
    userAgent: requireString(raw, 'user_agent', path),
    rateLimitMs: requirePositiveInteger(raw, 'rate_limit_ms', path),
    maxResponseBytes: requirePositiveInteger(raw, 'max_response_bytes', path),
    forbiddenHosts,
    mameSource: {
      enabled: requireBoolean(mameSource, 'enabled', path),
      rawBaseUrl: requireString(mameSource, 'raw_base_url', path),
      blobBaseUrl: requireString(mameSource, 'blob_base_url', path),
      sourceRoot: requireString(mameSource, 'source_root', path),
    },
    wikidata: {
      enabled: requireBoolean(wikidata, 'enabled', path),
      endpoint: requireString(wikidata, 'endpoint', path),
      entityBaseUrl: requireString(wikidata, 'entity_base_url', path),
      properties: [...readStringMap(wikidata, 'properties', path)].map(([id, role]) => ({
        id,
        role,
      })),
    },
    wikipedia: {
      enabled: requireBoolean(wikipedia, 'enabled', path),
      apiUrl: requireString(wikipedia, 'api_url', path),
      permalinkBaseUrl: requireString(wikipedia, 'permalink_base_url', path),
      titlesPerRequest: requirePositiveInteger(wikipedia, 'titles_per_request', path),
      infoboxFields: requireStringArray(wikipedia, 'infobox_fields', path),
      sectionHeadings: requireStringArray(wikipedia, 'section_headings', path),
    },
    jtcores: {
      enabled: requireBoolean(jtcores, 'enabled', path),
      repo: requireString(jtcores, 'repo', path),
      commit,
      treeApiUrl: requireString(jtcores, 'tree_api_url', path),
      rawBaseUrl: requireString(jtcores, 'raw_base_url', path),
      blobBaseUrl: requireString(jtcores, 'blob_base_url', path),
      hdlSuffixes: requireStringArray(jtcores, 'hdl_suffixes', path),
      configFiles: requireStringArray(jtcores, 'config_files', path),
    },
    recognition: {
      contextPattern: requireString(recognition, 'context_pattern', path),
      vendorPrefixes: requireStringArray(recognition, 'vendor_prefixes', path)
        .map((prefix) => prefix.toUpperCase())
        // Longest first: stripping `OKI` from `OKIM6295` before `OKIM` would leave `M6295`
        // under one prefix order and `6295` under the other.
        .sort((a, b) => b.length - a.length || compareBytes(a, b)),
      patterns: readPatterns(recognition, path),
      partAliases: readStringMap(recognition, 'part_aliases', path),
      ignoredParts: new Set(requireStringArray(recognition, 'ignored_parts', path)),
      minCatalogLiteralLength: requirePositiveInteger(
        recognition,
        'min_catalog_literal_length',
        path,
      ),
    },
    guard: {
      skipDirectories: requireStringArray(guard, 'skip_directories', path),
      skipFiles: requireStringArray(guard, 'skip_files', path),
      maxFileBytes: requirePositiveInteger(guard, 'max_file_bytes', path),
      rowFileRoots: requireStringArray(guard, 'row_file_roots', path),
      allowedRowKeys: requireStringArray(guard, 'allowed_row_keys', path),
      proseExtensions: requireStringArray(guard, 'prose_extensions', path),
      fetchVerbs: requireStringArray(guard, 'fetch_verbs', path).map((verb) => verb.toLowerCase()),
      fetchContextLines: requirePositiveInteger(guard, 'fetch_context_lines', path),
    },
  };
}

/** Reads the per-system witness bindings. */
export function loadReconcileBindings(path: string = RECONCILE_SYSTEMS_PATH): ReconcileBindings {
  const raw = readJson(path);
  const systems: SystemBinding[] = [];
  for (const [systemId, value] of Object.entries(requireObject(raw, 'systems', path))) {
    if (!isPlainObject(value)) throw new Error(`${path}: systems['${systemId}'] must be an object`);
    const wikidata = value['wikidata'];
    const wikipedia = value['wikipedia'];
    const cores = value['jtcores'];
    if (wikidata !== undefined && (typeof wikidata !== 'string' || !/^Q\d+$/.test(wikidata))) {
      throw new Error(`${path}: systems['${systemId}'].wikidata must look like 'Q1034233'`);
    }
    if (wikipedia !== undefined && typeof wikipedia !== 'string') {
      throw new Error(`${path}: systems['${systemId}'].wikipedia must be a string`);
    }
    if (
      cores !== undefined &&
      (!Array.isArray(cores) || cores.some((c) => typeof c !== 'string'))
    ) {
      throw new Error(`${path}: systems['${systemId}'].jtcores must be an array of strings`);
    }
    systems.push({
      systemId,
      ...(typeof wikidata === 'string' ? { wikidata } : {}),
      ...(typeof wikipedia === 'string' ? { wikipedia } : {}),
      jtcores: [...((cores as string[] | undefined) ?? [])].sort(compareBytes),
    });
  }

  const jtModules: JtModule[] = [];
  for (const [module, value] of Object.entries(requireObject(raw, 'jt_modules', path))) {
    if (!isPlainObject(value)) {
      throw new Error(
        `${path}: jt_modules['${module}'] must be an object with 'part' and 'note'. ` +
          'Saying which silicon a Verilog module implements is a claim about hardware, and ' +
          'standing rule 3 requires the ground for it to travel with it.',
      );
    }
    jtModules.push({
      module,
      part: requireString(value, 'part', `${path} jt_modules['${module}']`),
      note: requireString(value, 'note', `${path} jt_modules['${module}']`),
    });
  }

  return {
    version: requireString(raw, 'version', path),
    systems: systems.sort((a, b) => compareBytes(a.systemId, b.systemId)),
    jtModules: jtModules.sort((a, b) => compareBytes(a.module, b.module)),
  };
}
