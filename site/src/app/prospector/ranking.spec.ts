import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { openFixtureDatabase } from '../../testing/fixture-database';
import { PROSPECTOR_CONFIG } from './prospector-config.generated';
import {
  PROSPECTOR_DETAIL_SQL,
  PROSPECTOR_RANK_SQL,
  type ProspectorDetailRow,
  type ProspectorRankRow,
  type ProspectorRanking,
  compareBytes,
  rankParams,
  rankProspects,
  weightParams,
} from './ranking';

/**
 * T7.7 renders a score T6.3 defines, and `ranking.ts` is a port of the pipeline's
 * `rank.ts` rather than a second ranking. Three layers keep that claim true:
 *
 * 1. **this spec's source guard** — the shared `detail` CTE and every computed line of
 *    `RANK_SQL` are compared against `pipeline/src/prospector/rank.ts` *as text*, so a
 *    predicate edited on one side and not the other fails `ng test`;
 * 2. **this spec's behavioural checks** — the port is run over the fixture database and
 *    its arithmetic, ordering and breakdown identities are asserted against numbers
 *    worked out by hand;
 * 3. **`site/tools/verify-prospector-parity.mjs`** — runs `pipeline prospector --json`
 *    and this module over the *real* `dist/bomsquad.sqlite` and deep-compares every
 *    field of every entry on every platform. Not in `ng test`, because it needs a built
 *    database and the pipeline workspace.
 *
 * The fixture is small but carries the case the whole ranking exists for: `sega-system1`
 * shows 3/3 chips satisfied — a nominal 100 % — and still ranks *below* `capcom-cps1` at
 * 3/4, because one of its devices is uncatalogued and one of its sockets is covered only
 * through an equivalence. If a refactor ever made the thin catalogue win, this fails.
 */

const SITE_ROOT = process.cwd();
const REPO_ROOT = resolve(SITE_ROOT, '..');

function rank(platformId: string): ProspectorRanking {
  const db = openFixtureDatabase();
  try {
    const rankRows = db
      .prepare(PROSPECTOR_RANK_SQL)
      .all(unprefixed(rankParams(PROSPECTOR_CONFIG, platformId))) as unknown as ProspectorRankRow[];
    const detailRows = db
      .prepare(PROSPECTOR_DETAIL_SQL)
      .all(unprefixed(weightParams(PROSPECTOR_CONFIG))) as unknown as ProspectorDetailRow[];
    return rankProspects(rankRows, detailRows, PROSPECTOR_CONFIG, platformId);
  } finally {
    db.close();
  }
}

/** `node:sqlite` binds `{ name }`; the browser layer binds `{ ':name' }`. */
function unprefixed(params: Record<string, string | number>): Record<string, string | number> {
  return Object.fromEntries(Object.entries(params).map(([key, value]) => [key.slice(1), value]));
}

/** A template literal declared as `const NAME = \`…\`` in the pipeline's rank.ts. */
function pipelineTemplate(name: string): string {
  const source = readFileSync(join(REPO_ROOT, 'pipeline/src/prospector/rank.ts'), 'utf8');
  const match = new RegExp(`const ${name} = \`([\\s\\S]*?)\`;`).exec(source);
  if (match?.[1] === undefined) {
    throw new Error(`pipeline/src/prospector/rank.ts no longer declares ${name}`);
  }
  return match[1];
}

/**
 * The statement's *code* lines, trimmed. `--` comments are dropped: prose explaining a
 * predicate is not the predicate, and the two files write it for different readers.
 */
function lines(sql: string): string[] {
  return sql
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('--'));
}

describe('the ported SQL is the pipeline’s SQL', () => {
  it('shares the detail CTE verbatim', () => {
    const pipeline = pipelineTemplate('DETAIL_CTE').replaceAll('${KIND}', 'fpga_hdl');

    // The CTE is where every weight, credit and taxonomy branch is decided. It is
    // compared line for line, not merely "contains".
    expect(lines(PROSPECTOR_RANK_SQL)).toEqual(expect.arrayContaining(lines(pipeline)));
    expect(lines(PROSPECTOR_DETAIL_SQL)).toEqual(expect.arrayContaining(lines(pipeline)));
  });

  it('adds only projection columns to the ranking statement', () => {
    const pipeline = pipelineTemplate('RANK_SQL')
      .replace('${DETAIL_CTE}', pipelineTemplate('DETAIL_CTE'))
      .replaceAll('${KIND}', 'fpga_hdl');

    const extra = lines(PROSPECTOR_RANK_SQL).filter((line) => !lines(pipeline).includes(line));
    const missing = lines(pipeline).filter((line) => !lines(PROSPECTOR_RANK_SQL).includes(line));

    // Three columns the view needs for its filters and labels, and nothing else. If a
    // predicate, a join or an aggregate ever appears here, the port has diverged.
    expect(extra).toEqual([
      's.kind_id                        AS system_kind_id,',
      's.manufacturer_id,',
      's.year_introduced,',
    ]);
    expect(missing).toEqual([]);
  });

  it('carries the same scoring policy the pipeline reads', () => {
    const raw: unknown = JSON.parse(
      readFileSync(join(REPO_ROOT, 'pipeline/config/prospector.json'), 'utf8'),
    );
    const config = raw as {
      version: string;
      band_weight: Record<string, number>;
      route_credit: Record<string, number>;
      confidence_factor: Record<string, number>;
      unmapped_device_weight: number;
      system_mate_min_shared_chips: number;
      bonus: { system_mate_core: number; cpu_sound_complete: number };
    };

    expect(PROSPECTOR_CONFIG.version).toBe(config.version);
    expect(PROSPECTOR_CONFIG.bandWeight).toEqual(config.band_weight);
    expect(PROSPECTOR_CONFIG.routeCredit).toEqual(config.route_credit);
    expect(PROSPECTOR_CONFIG.confidenceFactor).toEqual(config.confidence_factor);
    expect(PROSPECTOR_CONFIG.unmappedDeviceWeight).toBe(config.unmapped_device_weight);
    expect(PROSPECTOR_CONFIG.systemMateMinSharedChips).toBe(config.system_mate_min_shared_chips);
    expect(PROSPECTOR_CONFIG.bonus.systemMateCore).toBe(config.bonus.system_mate_core);
    expect(PROSPECTOR_CONFIG.bonus.cpuSoundComplete).toBe(config.bonus.cpu_sound_complete);
  });
});

describe('rankProspects, against the fixture database', () => {
  it('ranks every core-less candidate on the platform', () => {
    const ranking = rank('mister');

    expect(ranking.platformId).toBe('mister');
    expect(ranking.candidateCount).toBe(2);
    expect(ranking.entries.map((entry) => entry.systemId)).toEqual(['capcom-cps1', 'sega-system1']);
    expect(ranking.entries.map((entry) => entry.rank)).toEqual([1, 2]);
  });

  it('demotes the thinly-catalogued board below the thoroughly catalogued one', () => {
    const [first, second] = rank('mister').entries;

    // sega-system1 is 3/3 satisfied — a nominal 100 % — and still loses to a 3/4 board.
    expect(second?.systemId).toBe('sega-system1');
    expect(second?.breakdown.chips.satisfied).toBe(second?.breakdown.chips.total);
    expect(first?.breakdown.chips.satisfied).toBeLessThan(first?.breakdown.chips.total ?? 0);
    expect(first?.score).toBeGreaterThan(second?.score ?? 0);
  });

  it('computes readiness as satisfied weight over chip weight plus unmapped weight', () => {
    const system1 = rank('mister').entries.find((entry) => entry.systemId === 'sega-system1');
    const readiness = system1?.breakdown.readiness;

    // z80 (cpu, medium, 2) + z80a (cpu, medium, 2) + ym2151 (sound, hard, 5) = 9.
    // z80a is satisfied through the equivalence edge, so it earns 2 × 0.9 = 1.8:
    // 2 + 1.8 + 5 = 8.8. One unmapped device adds 4 to the denominator.
    expect(readiness?.chipWeight).toBe(9);
    expect(readiness?.satisfiedWeight).toBe(8.8);
    expect(readiness?.unmappedWeight).toBe(4);
    expect(readiness?.totalWeight).toBe(13);
    expect(readiness?.value).toBe(0.676923);
  });

  it('reproduces the score exactly from the factors it publishes', () => {
    for (const entry of rank('mister').entries) {
      const { readiness, confidence, systemMateCore, cpuSoundComplete } = entry.breakdown;
      const product =
        readiness.value * confidence.factor * systemMateCore.factor * cpuSoundComplete.factor;

      expect(entry.score).toBe(Math.round(product * 1e6) / 1e6);
    }
  });

  it('names the missing chips with their bands, heaviest first', () => {
    const cps1 = rank('mister').entries.find((entry) => entry.systemId === 'capcom-cps1');

    expect(cps1?.breakdown.chips.missing).toEqual([
      { chipId: 'sega-315-5011', band: 'hard', weight: 5 },
    ]);
  });

  it('reports the substitution route rather than presenting it as a direct hit', () => {
    const system1 = rank('mister').entries.find((entry) => entry.systemId === 'sega-system1');

    expect(system1?.breakdown.chips.viaEdge).toEqual([
      { chipId: 'z80a', via: 'equivalent', providerChipId: 'z80', credit: 0.9 },
    ]);
    expect(system1?.breakdown.confidence.level).toBe('medium');
  });

  it('carries the unmapped-device caveat the coverage badge cannot', () => {
    const system1 = rank('mister').entries.find((entry) => entry.systemId === 'sega-system1');

    expect(system1?.breakdown.unmappedDevices).toEqual({ count: 1, weightEach: 4 });
  });

  it('is a total order — no tie is left to row order', () => {
    const entries = rank('generic').entries;
    const shuffled = [...entries].reverse();

    // Re-ranking the same rows in the opposite input order must produce the same list.
    expect(rank('generic').entries.map((entry) => entry.systemId)).toEqual(
      entries.map((entry) => entry.systemId),
    );
    expect(shuffled.map((entry) => entry.systemId)).not.toEqual(
      entries.map((entry) => entry.systemId),
    );
  });

  it('withholds the CPU+sound bonus when the basis has no sound socket at all', () => {
    // Vacuous completeness is the thin-catalogue trap again: neither fixture system has
    // a chip whose function begins `sound-`, so neither may earn the bonus.
    for (const entry of rank('mister').entries) {
      expect(entry.breakdown.cpuSoundComplete.soundChips).toBe(0);
      expect(entry.breakdown.cpuSoundComplete.applied).toBe(false);
      expect(entry.breakdown.cpuSoundComplete.factor).toBe(1);
    }
  });
});

describe('compareBytes', () => {
  it('orders by UTF-8 bytes, as the pipeline’s Buffer.compare does', () => {
    expect(compareBytes('a', 'b')).toBeLessThan(0);
    expect(compareBytes('b', 'a')).toBeGreaterThan(0);
    expect(compareBytes('abc', 'abc')).toBe(0);
    expect(compareBytes('ab', 'abc')).toBeLessThan(0);
    // Beyond the slug grammar, where UTF-16 order and UTF-8 byte order diverge.
    expect(Math.sign(compareBytes('ÿ', '＀'))).toBe(-1);
  });
});
