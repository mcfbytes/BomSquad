/**
 * The only way `pipeline reconcile` reaches the network, and the run-time half of the
 * system16.com rule.
 *
 * Three properties, and each is a requirement of TASKS T3.8 rather than a nicety:
 *
 * - **Refuses a forbidden host.** {@link ReconcileFetcher} checks every URL against
 *   `config/reconcile.json`'s `forbidden_hosts` *before* it looks in the cache, and throws
 *   with the reason the config gives. `reconcile/guard.ts` enforces the same list over the
 *   repository text, so a fetch that somehow got written would have to defeat both a static
 *   scan and this check. Neither is sufficient alone: a grep cannot see a hostname assembled
 *   from configuration at run time, and this cannot see a `curl` in a shell script.
 * - **Deterministic given a cached snapshot.** Every response is stored under `.cache/`
 *   keyed by the SHA-256 of the request, so a second run issues no network request at all
 *   and produces the same bytes. Nothing time-varying is stored in the cache entry, because
 *   anything stored there is something a later run could accidentally emit.
 * - **Rate limited.** One shared clock, `rate_limit_ms` between requests. These are other
 *   people's servers and several of them ask for exactly this in writing.
 *
 * A non-200 response is cached too. Wikipedia will return 404 for an article title a
 * curator mistyped, and re-asking every run helps nobody; the caller sees the status and
 * decides. Only transport failures are left uncached, since those are about the network
 * rather than about the resource.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { RECONCILE_CACHE_DIR, type ForbiddenHost, type ReconcileConfig } from './config.js';

/** Thrown when something asks for a host `forbidden_hosts` names. Never caught internally. */
export class ForbiddenHostError extends Error {
  readonly host: string;
  readonly domain: string;

  constructor(host: string, forbidden: ForbiddenHost) {
    super(
      `reconcile: refusing to fetch '${host}'. ${forbidden.domain} is reference-only: ` +
        forbidden.reason,
    );
    this.name = 'ForbiddenHostError';
    this.host = host;
    this.domain = forbidden.domain;
  }
}

export interface FetchedResource {
  readonly url: string;
  readonly status: number;
  readonly body: string;
  /** False when the body came from `.cache/` and no request was issued. */
  readonly fromNetwork: boolean;
}

/** A cache entry, on disk. Deliberately carries no timestamp — see the module comment. */
interface CacheEntry {
  readonly url: string;
  readonly status: number;
  readonly body: string;
}

/**
 * `www.system16.com` matches the `system16.com` rule, `notsystem16.com` does not. Matching
 * on the registrable domain rather than the exact hostname is what stops the rule being one
 * subdomain away from useless.
 */
export function findForbidden(
  url: string,
  forbiddenHosts: readonly ForbiddenHost[],
): ForbiddenHost | undefined {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return undefined; // a malformed URL is the caller's bug, reported where it is used
  }
  return forbiddenHosts.find((entry) => host === entry.domain || host.endsWith(`.${entry.domain}`));
}

function cacheKey(url: string, body: string | undefined): string {
  const hash = createHash('sha256');
  hash.update(url);
  if (body !== undefined) hash.update('\n');
  if (body !== undefined) hash.update(body);
  return hash.digest('hex');
}

/**
 * A rate-limited, response-caching fetcher for one run.
 *
 * Stateful on purpose — the rate limiter needs a clock shared across every witness, since
 * three of the four talk to Wikimedia infrastructure and a per-witness limiter would let
 * them add up.
 */
export class ReconcileFetcher {
  private readonly config: ReconcileConfig;
  private readonly cacheDir: string;
  private readonly log: (line: string) => void;
  private nextRequestAt = 0;
  private networkRequests = 0;
  private cacheHits = 0;

  constructor(
    config: ReconcileConfig,
    options: { readonly cacheDir?: string; readonly log?: (line: string) => void } = {},
  ) {
    this.config = config;
    this.cacheDir = options.cacheDir ?? RECONCILE_CACHE_DIR;
    this.log = options.log ?? ((): void => undefined);
  }

  /** How the run went, for the CLI's log. Not written into any artefact. */
  get stats(): { readonly networkRequests: number; readonly cacheHits: number } {
    return { networkRequests: this.networkRequests, cacheHits: this.cacheHits };
  }

  /**
   * GETs `url`, or POSTs `body` to it when one is given (the SPARQL endpoint wants a POST
   * for anything longer than a trivial query). Returns the cached copy when there is one.
   */
  async fetch(
    url: string,
    options: { readonly body?: string; readonly accept?: string } = {},
  ): Promise<FetchedResource> {
    const forbidden = findForbidden(url, this.config.forbiddenHosts);
    if (forbidden !== undefined) {
      throw new ForbiddenHostError(new URL(url).hostname, forbidden);
    }

    const path = join(this.cacheDir, `${cacheKey(url, options.body)}.json`);
    const cached = await this.readCache(path);
    if (cached !== undefined) {
      this.cacheHits += 1;
      return { url, status: cached.status, body: cached.body, fromNetwork: false };
    }

    await this.waitForSlot();
    this.log(`reconcile: GET ${url}`);
    const response = await fetch(url, {
      method: options.body === undefined ? 'GET' : 'POST',
      headers: {
        'user-agent': this.config.userAgent,
        ...(options.accept !== undefined ? { accept: options.accept } : {}),
        ...(options.body === undefined
          ? {}
          : { 'content-type': 'application/x-www-form-urlencoded' }),
      },
      ...(options.body === undefined ? {} : { body: options.body }),
    });
    this.networkRequests += 1;

    const text = await response.text();
    if (text.length > this.config.maxResponseBytes) {
      throw new Error(
        `reconcile: ${url} returned ${text.length} bytes, over the ` +
          `${this.config.maxResponseBytes}-byte limit in config/reconcile.json`,
      );
    }
    const entry: CacheEntry = { url, status: response.status, body: text };
    await this.writeCache(path, entry);
    return { url, status: entry.status, body: entry.body, fromNetwork: true };
  }

  private async readCache(path: string): Promise<CacheEntry | undefined> {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      return undefined;
    }
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== 'object' || raw === null) return undefined;
    const entry = raw as Record<string, unknown>;
    const status = entry['status'];
    const body = entry['body'];
    const url = entry['url'];
    if (typeof status !== 'number' || typeof body !== 'string' || typeof url !== 'string') {
      return undefined; // a cache entry this code did not write is not a cache entry
    }
    return { url, status, body };
  }

  /** Writes through a `.partial` rename, so an interrupted run leaves no truncated entry. */
  private async writeCache(path: string, entry: CacheEntry): Promise<void> {
    await mkdir(this.cacheDir, { recursive: true });
    const partial = `${path}.partial`;
    await writeFile(partial, `${JSON.stringify(entry)}\n`);
    await rename(partial, path);
  }

  private async waitForSlot(): Promise<void> {
    const wait = this.nextRequestAt - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.nextRequestAt = Date.now() + this.config.rateLimitMs;
  }
}
