/**
 * `pipeline mame:fetch` — acquire the pinned release's listxml archive, verified.
 *
 * The contract (TASKS T2.1) is three sentences: the fetch produces a verified archive, a
 * second run is a cache hit, and changing the pin fetches the new version. All three fall
 * out of one rule — **the cache is content-addressed by the release's own filename and
 * validated by hash on every run** — rather than from a freshness heuristic:
 *
 * - *Verified*: the archive's SHA-256 must equal the entry for it in the release's
 *   published `SHA256SUMS` asset. There is no hash pinned in `config/mame.json`, because a
 *   hash there would be a second thing to bump and the first thing to be bumped wrong.
 * - *Cache hit*: `SHA256SUMS` is cached beside the archive, so a warm cache re-verifies
 *   from disk and issues **no network request at all**. That matters beyond speed — CI and
 *   an offline `mame:extract` must not depend on GitHub being reachable.
 * - *New pin*: the cache path contains the asset filename, which contains the release, so
 *   a bumped pin simply misses.
 *
 * A hash mismatch **deletes the cached file** before throwing. Leaving a known-bad 20 MB
 * archive on disk to fail identically on every subsequent run is the failure mode where
 * someone eventually passes `--force` at the wrong moment.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CACHE_DIR, type MameConfig } from './config.js';

export interface FetchResult {
  /** Absolute path to the verified archive. */
  readonly archivePath: string;
  /** Verified lowercase hex SHA-256 of the archive. */
  readonly sha256: string;
  readonly bytes: number;
  /** False when the archive was already present and re-verified from disk. */
  readonly downloaded: boolean;
}

/**
 * Where a fetched asset lives: one directory per release. That is what makes "change the
 * pin, get the new version" fall out of a plain filesystem miss, and it means an old
 * release's files stay put and re-verify instantly if the pin is ever rolled back.
 */
export function cachePath(config: MameConfig, asset: string, cacheDir = CACHE_DIR): string {
  return join(cacheDir, config.release, asset);
}

/** Streaming SHA-256, so a 20 MB archive is never held in memory to be hashed. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * Parses a `sha256sum` manifest into `filename → hex digest`.
 *
 * GNU coreutils writes `<hex>  <name>` for text mode and `<hex> *<name>` for binary mode,
 * and MAME publishes the binary form. Both are accepted; anything else is ignored rather
 * than guessed at, and a missing entry is caught by the caller, which knows the filename.
 */
export function parseChecksums(text: string): Map<string, string> {
  const digests = new Map<string, string>();
  for (const line of text.split('\n')) {
    const [, digest, name] = /^([0-9a-fA-F]{64}) [ *](.+?)\r?$/.exec(line) ?? [];
    if (digest !== undefined && name !== undefined) digests.set(name, digest.toLowerCase());
  }
  return digests;
}

function assetUrl(config: MameConfig, asset: string): string {
  return `${config.releaseBaseUrl}/${config.release}/${asset}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Downloads to `<path>.partial` and renames on success, so an interrupted run can never
 * leave a truncated file that the next run would happily hash-check and reject forever.
 */
async function download(url: string, path: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`mame:fetch: GET ${url} returned ${response.status} ${response.statusText}`);
  }
  if (response.body === null) throw new Error(`mame:fetch: GET ${url} returned no body`);
  const partial = `${path}.partial`;
  await writeFile(partial, response.body);
  await rename(partial, path);
}

/** The release's checksum manifest, from cache when present. */
async function readChecksums(
  config: MameConfig,
  cacheDir: string,
  log: (line: string) => void,
): Promise<Map<string, string>> {
  const path = cachePath(config, config.checksumsAsset, cacheDir);
  if (!(await exists(path))) {
    const url = assetUrl(config, config.checksumsAsset);
    log(`mame:fetch: downloading ${url}`);
    await download(url, path);
  }
  return parseChecksums(await readFile(path, 'utf8'));
}

/**
 * Fetches (or re-verifies) the pinned listxml archive.
 *
 * `log` defaults to nothing so the function is usable from a test without capturing
 * stdout; the CLI passes a writer.
 */
export async function fetchListxml(
  config: MameConfig,
  options: { readonly cacheDir?: string; readonly log?: (line: string) => void } = {},
): Promise<FetchResult> {
  const cacheDir = options.cacheDir ?? CACHE_DIR;
  const log = options.log ?? ((): void => undefined);
  await mkdir(join(cacheDir, config.release), { recursive: true });

  const digests = await readChecksums(config, cacheDir, log);
  const expected = digests.get(config.listxmlAsset);
  if (expected === undefined) {
    throw new Error(
      `mame:fetch: '${config.listxmlAsset}' is not listed in ${config.checksumsAsset} for ` +
        `${config.release} (it lists ${[...digests.keys()].join(', ')}). Check config/mame.json.`,
    );
  }

  const archivePath = cachePath(config, config.listxmlAsset, cacheDir);
  const cached = await exists(archivePath);
  if (!cached) {
    const url = assetUrl(config, config.listxmlAsset);
    log(`mame:fetch: downloading ${url}`);
    await download(url, archivePath);
  }

  const actual = await sha256File(archivePath);
  if (actual !== expected) {
    await rm(archivePath, { force: true });
    throw new Error(
      `mame:fetch: ${config.listxmlAsset} has SHA-256 ${actual}, expected ${expected} from ` +
        `${config.checksumsAsset}. The cached copy has been deleted; re-run to fetch it again.`,
    );
  }

  const { size } = await stat(archivePath);
  log(
    `mame:fetch: ${cached ? 'cache hit' : 'downloaded'} ${config.listxmlAsset} ` +
      `(${size} bytes, sha256 ${actual})`,
  );
  return { archivePath, sha256: actual, bytes: size, downloaded: !cached };
}
