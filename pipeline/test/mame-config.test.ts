/**
 * The pin and the extraction policy.
 *
 * A half-edited pin is the failure this file mostly exists for: bumping `release` and
 * forgetting `listxml_asset` would download last month's XML and label it with this
 * month's version, and nothing downstream could tell. The cross-checks in
 * `loadMameConfig` make that a load error instead.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  bumpMameConfig,
  EXTRACT_CONFIG_PATH,
  formatMameConfigJson,
  loadExtractConfig,
  loadMameConfig,
  MAME_CONFIG_PATH,
} from '../src/mame/config.js';
import { cachePath, parseChecksums } from '../src/mame/fetch.js';

const dir = mkdtempSync(join(tmpdir(), 'bomsquad-mame-config-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const PIN = {
  release: 'mame0288',
  version: '0.288',
  release_base_url: 'https://github.com/mamedev/mame/releases/download',
  listxml_asset: 'mame0288lx.zip',
  checksums_asset: 'SHA256SUMS',
};

/** Writes a variant of the shipped pin and returns its path. */
function pin(name: string, overrides: Readonly<Record<string, unknown>>): string {
  const path = join(dir, `${name}.json`);
  writeFileSync(path, JSON.stringify({ ...PIN, ...overrides }));
  return path;
}

describe('the shipped pin', () => {
  it('loads, and names exactly one MAME release', () => {
    const config = loadMameConfig(MAME_CONFIG_PATH);
    expect(config.release).toBe('mame0288');
    expect(config.version).toBe('0.288');
    expect(config.listxmlAsset).toBe('mame0288lx.zip');
  });

  it('caches each release in its own directory, so bumping the pin is a cache miss', () => {
    const config = loadMameConfig(MAME_CONFIG_PATH);
    expect(cachePath(config, config.listxmlAsset, '/c')).toBe('/c/mame0288/mame0288lx.zip');
    expect(cachePath({ ...config, release: 'mame0289' }, 'mame0289lx.zip', '/c')).toBe(
      '/c/mame0289/mame0289lx.zip',
    );
  });
});

describe('rejecting a half-edited pin', () => {
  it('fails when the version does not follow from the release tag', () => {
    expect(() => loadMameConfig(pin('bad-version', { release: 'mame0289' }))).toThrow(
      /release 'mame0289' means '0\.289'/,
    );
  });

  it('fails when the asset is not an asset of the pinned release', () => {
    expect(() =>
      loadMameConfig(pin('bad-asset', { release: 'mame0289', version: '0.289' })),
    ).toThrow(/not an asset of release 'mame0289'/);
  });

  it('fails on a release tag that is not a MAME release tag', () => {
    expect(() => loadMameConfig(pin('bad-tag', { release: 'latest' }))).toThrow(
      /must look like 'mame0288'/,
    );
  });

  it('refuses a plaintext download root', () => {
    expect(() =>
      loadMameConfig(pin('http', { release_base_url: 'http://example.invalid' })),
    ).toThrow(/must be https/);
  });
});

describe('bumping the pin (TASKS T2.6)', () => {
  const current = loadMameConfig(MAME_CONFIG_PATH);

  it('derives the version and asset name from the new release tag alone', () => {
    expect(bumpMameConfig(current, 'mame0289')).toEqual({
      release: 'mame0289',
      version: '0.289',
      releaseBaseUrl: current.releaseBaseUrl,
      listxmlAsset: 'mame0289lx.zip',
      checksumsAsset: current.checksumsAsset,
    });
  });

  it('carries release_base_url and checksums_asset over unchanged', () => {
    const custom = { ...current, checksumsAsset: 'CHECKSUMS.txt' };
    expect(bumpMameConfig(custom, 'mame0290').checksumsAsset).toBe('CHECKSUMS.txt');
  });

  it('rejects a tag loadMameConfig would also refuse, before anything is written', () => {
    expect(() => bumpMameConfig(current, 'latest')).toThrow(/must look like 'mame0288'/);
    expect(() => bumpMameConfig(current, 'mame')).toThrow(/must look like 'mame0288'/);
  });

  it('the bumped config loads cleanly through loadMameConfig’s own cross-checks', () => {
    const bumped = bumpMameConfig(current, 'mame0300');
    const path = join(dir, 'bumped.json');
    writeFileSync(path, formatMameConfigJson(bumped));
    expect(loadMameConfig(path)).toEqual(bumped);
  });
});

describe('formatting the pin back to JSON', () => {
  it('round-trips the shipped pin byte for byte', () => {
    const config = loadMameConfig(MAME_CONFIG_PATH);
    expect(formatMameConfigJson(config)).toBe(readFileSync(MAME_CONFIG_PATH, 'utf8'));
  });

  it('is a formatter, not a rename: bumping and formatting again changes only what bumped', () => {
    const config = loadMameConfig(MAME_CONFIG_PATH);
    const bumped = bumpMameConfig(config, 'mame0289');
    const before = formatMameConfigJson(config).split('\n');
    const after = formatMameConfigJson(bumped).split('\n');
    expect(before.length).toBe(after.length);
    const changedLines = before.filter((line, index) => line !== after[index]);
    expect(changedLines).toEqual([
      `  "release": "${config.release}",`,
      `  "version": "${config.version}",`,
      `  "listxml_asset": "${config.listxmlAsset}",`,
    ]);
  });
});

describe('the shipped extraction policy', () => {
  const config = loadExtractConfig(EXTRACT_CONFIG_PATH);

  it('is parents-only and drops devices and mechanical machines by default', () => {
    expect(config.filter).toMatchObject({
      parentsOnly: true,
      dropDevices: true,
      dropMechanical: true,
      // A BIOS set is real hardware with a real BOM, so it is kept.
      dropBios: false,
    });
  });

  it('sorts both rule lists bytewise, so no output can inherit the file key order', () => {
    const patterns = config.filter.excludeSourcefile.map((rule) => rule.pattern);
    expect(patterns).toEqual([...patterns].sort());
    expect(patterns.length).toBeGreaterThan(0);
  });

  it('gives every exclusion a reason, because MAME publishes no genre field', () => {
    for (const rule of [...config.filter.excludeSourcefile, ...config.filter.keepSourcefile]) {
      expect(rule.reason.trim(), rule.pattern).not.toBe('');
    }
  });

  it('records the no-genre-field limitation in the config file itself', () => {
    const raw = loadRaw(EXTRACT_CONFIG_PATH);
    expect(JSON.stringify(raw['limitations'])).toMatch(/no genre|NO genre/i);
    expect(JSON.stringify(raw['limitations'])).toMatch(/catver\.ini/);
  });
});

describe('rejecting an unusable extraction policy', () => {
  /** A variant of the shipped policy with one field replaced. */
  function policy(name: string, mutate: (raw: Record<string, unknown>) => void): string {
    const raw = loadRaw(EXTRACT_CONFIG_PATH);
    mutate(raw);
    const path = join(dir, `${name}.json`);
    writeFileSync(path, JSON.stringify(raw));
    return path;
  }

  it('fails when an exclusion has no reason', () => {
    expect(() =>
      loadExtractConfig(
        policy('no-reason', (raw) => {
          (raw['filter'] as Record<string, Record<string, string>>)['exclude_sourcefile'] = {
            'igt/': '',
          };
        }),
      ),
    ).toThrow(/must be a non-empty reason/);
  });

  it('fails when a path is both excluded and kept', () => {
    expect(() =>
      loadExtractConfig(
        policy('contradiction', (raw) => {
          const filter = raw['filter'] as Record<string, Record<string, string>>;
          filter['exclude_sourcefile'] = { 'igt/peplus.cpp': 'excluded' };
          filter['keep_sourcefile'] = { 'igt/peplus.cpp': 'kept' };
        }),
      ),
    ).toThrow(/in both keep_sourcefile and exclude_sourcefile/);
  });

  it('fails on a worklist sample size that is not a positive integer', () => {
    expect(() =>
      loadExtractConfig(
        policy('bad-sample', (raw) => {
          (raw['worklist'] as Record<string, unknown>)['sample_machine_ids'] = 0;
        }),
      ),
    ).toThrow(/positive integer/);
  });
});

describe('checksum manifests', () => {
  it('reads the binary-mode form MAME publishes and the text-mode form too', () => {
    const digests = parseChecksums(
      `${'a'.repeat(64)} *mame0288lx.zip\n${'b'.repeat(64)}  SHA1SUMS\n\n# a comment\n`,
    );
    expect([...digests]).toEqual([
      ['mame0288lx.zip', 'a'.repeat(64)],
      ['SHA1SUMS', 'b'.repeat(64)],
    ]);
  });

  it('tolerates CRLF line endings', () => {
    expect(parseChecksums(`${'c'.repeat(64)} *x.zip\r\n`).get('x.zip')).toBe('c'.repeat(64));
  });
});

function loadRaw(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}
