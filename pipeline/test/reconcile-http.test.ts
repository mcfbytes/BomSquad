/**
 * TASKS T3.8 — the fetcher: the run-time half of the no-fetch rule, and the reason a run is
 * reproducible.
 *
 * As in `reconcile-guard.test.ts`, the forbidden host is read from the shipped
 * `config/reconcile.json` rather than written here, so this file cannot itself become the
 * violation the guard exists to catch — and so the two halves of the rule are provably
 * reading one declaration rather than two copies of one.
 *
 * Nothing here reaches the network. `globalThis.fetch` is replaced for the duration of a
 * test, which is also how the cache claim is proved: the second call must not reach the
 * stub at all.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadReconcileConfig } from '../src/reconcile/config.js';
import { findForbidden, ForbiddenHostError, ReconcileFetcher } from '../src/reconcile/http.js';

const config = { ...loadReconcileConfig(), rateLimitMs: 1 };
const domain = config.forbiddenHosts[0]?.domain ?? '';

const created: string[] = [];
function cacheDir(): string {
  const path = mkdtempSync(join(tmpdir(), 'bomsquad-reconcile-'));
  created.push(path);
  return path;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('findForbidden — the rule matches a domain, not one hostname', () => {
  it('matches the bare domain and any subdomain of it', () => {
    expect(findForbidden(`https://${domain}/x`, config.forbiddenHosts)?.domain).toBe(domain);
    expect(findForbidden(`https://www.${domain}/x`, config.forbiddenHosts)?.domain).toBe(domain);
  });

  it('does not match a different domain that merely ends in the same letters', () => {
    expect(findForbidden(`https://not${domain}/x`, config.forbiddenHosts)).toBeUndefined();
  });

  it('does not match a host that only contains it as a path', () => {
    expect(
      findForbidden(`https://example.invalid/${domain}`, config.forbiddenHosts),
    ).toBeUndefined();
  });
});

describe('ReconcileFetcher', () => {
  it('refuses a forbidden host before it looks at the cache or the network', async () => {
    let called = false;
    globalThis.fetch = (): never => {
      called = true;
      throw new Error('must not be reached');
    };
    const fetcher = new ReconcileFetcher(config, { cacheDir: cacheDir() });
    await expect(fetcher.fetch(`https://www.${domain}/segabd/`)).rejects.toBeInstanceOf(
      ForbiddenHostError,
    );
    expect(called).toBe(false);
  });

  it('puts the source owner’s reason in the error, not a bare refusal', async () => {
    const fetcher = new ReconcileFetcher(config, { cacheDir: cacheDir() });
    await expect(fetcher.fetch(`https://${domain}/x`)).rejects.toThrow(/reference-only/);
  });

  it('caches by request, so a second run issues no request at all', async () => {
    let requests = 0;
    globalThis.fetch = (): Promise<Response> => {
      requests += 1;
      return Promise.resolve(new Response('body', { status: 200 }));
    };
    const directory = cacheDir();
    const first = new ReconcileFetcher(config, { cacheDir: directory });
    expect((await first.fetch('https://example.invalid/a')).fromNetwork).toBe(true);

    // A fresh fetcher, as a second `pipeline reconcile` run would build.
    const second = new ReconcileFetcher(config, { cacheDir: directory });
    const cached = await second.fetch('https://example.invalid/a');
    expect(cached.fromNetwork).toBe(false);
    expect(cached.body).toBe('body');
    expect(requests).toBe(1);
    expect(second.stats).toEqual({ networkRequests: 0, cacheHits: 1 });
  });

  it('keys the cache on the POST body too, so two SPARQL queries do not collide', async () => {
    let index = 0;
    globalThis.fetch = (): Promise<Response> =>
      Promise.resolve(new Response(`answer ${index++}`, { status: 200 }));
    const fetcher = new ReconcileFetcher(config, { cacheDir: cacheDir() });
    const first = await fetcher.fetch('https://example.invalid/sparql', { body: 'query=one' });
    const second = await fetcher.fetch('https://example.invalid/sparql', { body: 'query=two' });
    expect(first.body).not.toBe(second.body);
  });

  it('caches a non-200 rather than re-asking every run', async () => {
    let requests = 0;
    globalThis.fetch = (): Promise<Response> => {
      requests += 1;
      return Promise.resolve(new Response('missing', { status: 404 }));
    };
    const directory = cacheDir();
    const fetcher = new ReconcileFetcher(config, { cacheDir: directory });
    expect((await fetcher.fetch('https://example.invalid/gone')).status).toBe(404);
    const again = new ReconcileFetcher(config, { cacheDir: directory });
    expect((await again.fetch('https://example.invalid/gone')).status).toBe(404);
    expect(requests).toBe(1);
  });

  it('refuses a response larger than the configured ceiling', async () => {
    globalThis.fetch = (): Promise<Response> =>
      Promise.resolve(new Response('x'.repeat(64), { status: 200 }));
    const fetcher = new ReconcileFetcher(
      { ...config, maxResponseBytes: 8 },
      { cacheDir: cacheDir() },
    );
    await expect(fetcher.fetch('https://example.invalid/big')).rejects.toThrow(/over the 8-byte/);
  });
});
