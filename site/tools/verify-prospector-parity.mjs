/**
 * Proves the browser's Prospector ranking is the pipeline's, not a second one.
 *
 *   node site/tools/verify-prospector-parity.mjs [--db <path>]
 *
 * T7.7 renders a score that T6.3 defines. `pipeline/src/prospector/rank.ts` runs on
 * `node:sqlite` and cannot be imported into a browser bundle, so
 * `site/src/app/prospector/ranking.ts` reproduces its two statements and its
 * arithmetic. "Reproduces" is a claim, and this is the check:
 *
 *  1. run `pipeline prospector --platform <p> --json` — the real T6.3 code path,
 *     reading the real `pipeline/config/prospector.json`, against the real database;
 *  2. run the site's `rankProspects()` over the same database through `node:sqlite`,
 *     with the config that `prospector-config.generated.ts` carries;
 *  3. deep-compare **every field of every entry** of both rankings, for **every**
 *     `fpga_platform` row — score, rank, order, readiness, band counts, `missing[]`
 *     with weights and bands, `viaEdge[]` with providers and credits, confidence,
 *     both bonus factors and the mate id.
 *
 * Any difference anywhere fails the run and prints the JSON path that differs.
 *
 * Not a unit test: it needs the built `dist/bomsquad.sqlite` and it shells out to the
 * pipeline workspace, neither of which belongs in `ng test`. `ranking.spec.ts` covers
 * the same module against the fixture database inside the suite; this is the one that
 * says the numbers on the deployed page are the numbers T6.3 published.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(SITE_ROOT, '..');

const { PROSPECTOR_CONFIG } = await import(
  join(SITE_ROOT, 'src/app/prospector/prospector-config.generated.ts')
);
const { PROSPECTOR_RANK_SQL, PROSPECTOR_DETAIL_SQL, rankParams, weightParams, rankProspects } =
  await import(join(SITE_ROOT, 'src/app/prospector/ranking.ts'));

/** `node:sqlite` binds `{ name: value }`; the site binds `{ ':name': value }`. */
function unprefixed(params) {
  return Object.fromEntries(Object.entries(params).map(([key, value]) => [key.slice(1), value]));
}

function siteRanking(db, platformId) {
  const rankRows = db
    .prepare(PROSPECTOR_RANK_SQL)
    .all(unprefixed(rankParams(PROSPECTOR_CONFIG, platformId)));
  const detailRows = db
    .prepare(PROSPECTOR_DETAIL_SQL)
    .all(unprefixed(weightParams(PROSPECTOR_CONFIG)));
  return rankProspects(rankRows, detailRows, PROSPECTOR_CONFIG, platformId);
}

function pipelineRanking(dbPath, platformId, top) {
  const result = spawnSync(
    'npx',
    [
      'tsx',
      'src/cli.ts',
      'prospector',
      '--platform',
      platformId,
      '--db',
      dbPath,
      '--top',
      String(top),
      '--json',
    ],
    { cwd: join(REPO_ROOT, 'pipeline'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(`pipeline prospector failed for '${platformId}':\n${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

/** Every leaf difference between two JSON values, as `path: a !== b`. */
function differences(a, b, path = '$', found = []) {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      found.push(`${path}: array shape ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
      return found;
    }
    a.forEach((item, index) => differences(item, b[index], `${path}[${index}]`, found));
    return found;
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const key of keys) {
      differences(a[key], b[key], `${path}.${key}`, found);
    }
    return found;
  }
  if (a !== b) {
    found.push(`${path}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
  return found;
}

/** The site adds three projection-only columns; the pipeline's entries have no such keys. */
const SITE_ONLY_KEYS = new Set(['systemKindId', 'manufacturerId', 'yearIntroduced']);

function comparable(entry) {
  return Object.fromEntries(Object.entries(entry).filter(([key]) => !SITE_ONLY_KEYS.has(key)));
}

function main(argv) {
  const dbFlag = argv.indexOf('--db');
  const dbPath = dbFlag === -1 ? join(REPO_ROOT, 'dist/bomsquad.sqlite') : argv[dbFlag + 1];

  if (!existsSync(dbPath)) {
    process.stderr.write(
      `verify-prospector-parity: '${dbPath}' not found.\n` +
        '  Build it with `npm run build:db --workspace @bomsquad/pipeline`.\n',
    );
    return 1;
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  let failures = 0;
  try {
    const platforms = db
      .prepare('SELECT platform_id FROM fpga_platform ORDER BY platform_id')
      .all()
      .map((row) => row.platform_id);

    process.stdout.write(
      `verify-prospector-parity: ${dbPath}\n` +
        `  config ${PROSPECTOR_CONFIG.version} · ${platforms.length} platforms\n\n`,
    );

    for (const platformId of platforms) {
      const site = siteRanking(db, platformId);
      const pipeline = pipelineRanking(dbPath, platformId, Math.max(site.candidateCount, 1));

      const problems = [];
      if (site.candidateCount !== pipeline.candidateCount) {
        problems.push(`candidateCount: ${site.candidateCount} !== ${pipeline.candidateCount}`);
      }
      if (site.entries.length !== pipeline.entries.length) {
        problems.push(`entries.length: ${site.entries.length} !== ${pipeline.entries.length}`);
      } else {
        site.entries.forEach((entry, index) => {
          differences(comparable(entry), pipeline.entries[index], `entries[${index}]`, problems);
        });
      }

      const verdict = problems.length === 0 ? 'OK  ' : 'FAIL';
      process.stdout.write(
        `  ${verdict} ${platformId.padEnd(10)} ${String(site.candidateCount).padStart(3)} candidates · ` +
          `top score ${site.entries[0]?.score.toFixed(6) ?? '—'} (${site.entries[0]?.systemId ?? 'none'})\n`,
      );
      for (const problem of problems.slice(0, 20)) {
        process.stdout.write(`         ${problem}\n`);
      }
      if (problems.length > 20) {
        process.stdout.write(`         … and ${problems.length - 20} more\n`);
      }
      failures += problems.length === 0 ? 0 : 1;
    }
  } finally {
    db.close();
  }

  process.stdout.write(
    failures === 0
      ? '\nverify-prospector-parity: every platform matches pipeline prospector exactly.\n'
      : `\nverify-prospector-parity: ${failures} platform(s) differ.\n`,
  );
  return failures === 0 ? 0 : 1;
}

process.exitCode = main(process.argv.slice(2));
