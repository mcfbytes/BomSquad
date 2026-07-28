/**
 * TASKS T6.3 — the weighted Prospector ranking (`src/prospector/rank.ts`).
 *
 * The assertions run over docs/coverage.md §6.0's fixture, loaded through the real
 * loader into the real schema, so every number below flows through the shipped views.
 * Scores are hand-derived in comments from the test's own inline policy (`CONFIG`) —
 * the shipped `pipeline/config/prospector.json` is deliberately *not* pinned here,
 * because tuning it is supposed to change results without breaking a test.
 *
 * The one thing this file must prove beyond correctness: **changing a config weight
 * changes the ranking with no code or schema change** ("config moves the ranking"
 * below), and the failure mode it exists to kill — a thinly-catalogued board at nominal
 * 100% outranking a thoroughly-catalogued one — stays dead unless a config edit
 * deliberately revives it.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { createSchemaDatabase, checkIntegrity } from '../src/db/schema.js';
import { loadRowFiles } from '../src/db/load.js';
import {
  loadProspectorConfig,
  rankProspects,
  formatProspectorReport,
  PROSPECTOR_CONFIG_PATH,
  type ProspectorConfig,
} from '../src/prospector/rank.js';
import { coverageFixture } from './fixtures.js';

/**
 * The test's own policy. Numerically identical to the shipped config as of this
 * writing, but owned by the test: the shipped file is free to move.
 */
const CONFIG: ProspectorConfig = {
  version: 'test',
  bandWeight: { hard: 5, medium: 2, soft: 1 },
  unmappedDeviceWeight: 4,
  routeCredit: { equivalent: 0.9, provides: 0.5 },
  confidenceFactor: { high: 1, medium: 0.85, low: 0.5 },
  bonus: { systemMateCore: 0.1, cpuSoundComplete: 0.15 },
  systemMateMinSharedChips: 2,
};

/**
 * Fixture facts the derivations below lean on (docs/coverage.md §6.0 + `fixtures.ts`):
 *
 * - Bands: every fixture chip is `cpu` / `sound-*` (band `medium`, weight 2) except
 *   `sega-315-5011` (`custom`, band `hard`, weight 5).
 * - The only fpga_hdl *core* is `fx-core-symmetric` → system `fx-symmetric` on
 *   platform `mister`. So on `pocket` every system is a candidate and `fx-symmetric`
 *   is its own mate (a core elsewhere); on `mister` it is excluded.
 * - Mates at min-shared 2 (distinct chips shared with fx-symmetric {z80, sn76489,
 *   ym2612, sega-315-5011}): fx-68k-miss {z80, sn76489}, fx-unmapped-med and
 *   fx-unmapped-low {z80, sn76489}, fx-kind {z80, sega-315-5011}. fx-68k-hit,
 *   fx-68k-notrans and fx-2a03 share only one chip — no bonus.
 */
describe('prospector ranking over the coverage fixture', () => {
  let db: DatabaseSync;

  beforeAll(() => {
    db = createSchemaDatabase();
    loadRowFiles(db, coverageFixture());
    expect(checkIntegrity(db)).toEqual([]);
  });

  it('ranks pocket by weighted readiness x confidence x bonuses, hand-derived', () => {
    const ranking = rankProspects(db, CONFIG, 'pocket');
    expect(ranking.platformId).toBe('pocket');
    expect(ranking.candidateCount).toBe(9);
    expect(ranking.entries.map((entry) => [entry.rank, entry.systemId, entry.score])).toEqual([
      // 10/14 = 0.714286 (5 medium chips self; 1 unmapped x4) x0.85 x1.1 x1.15
      [1, 'fx-unmapped-med', 0.768036],
      // 4/6 = 0.666667 (z80+sn76489 self, m68030 miss) x1.0 x1.1 mate
      [2, 'fx-68k-miss', 0.733334],
      // 4/6 = 0.666667 (rp2a03+sn76489 self, m6502 miss by the §1.6 doctrine), no bonus
      [3, 'fx-2a03', 0.666667],
      // (2x0.5 + 2)/4 = 0.75 provides-credited x0.85 (provides => medium confidence)
      [4, 'fx-68k-hit', 0.6375],
      // (2+2+2x0.9)/11 = 0.527273 x0.85 x1.1 self-mate (core on mister) x1.15
      [5, 'fx-symmetric', 0.56695],
      // 2/4 = 0.5 at high confidence, no bonuses
      [6, 'fx-68k-notrans', 0.5],
      // THE HEADLINE CASE: nominal share 1.0 (4/4 chips), but 2 unmapped devices make
      // it 8/16 = 0.5, and `low` confidence halves it: 0.5 x0.5 x1.1 x1.15 = 0.31625.
      // A board that "looks done" because its silicon is uncatalogued ranks 7th of 9.
      [7, 'fx-unmapped-low', 0.31625],
      // 2/9 = 0.222222 — the missing hard-band custom (weight 5) dominates x1.1
      [8, 'fx-kind', 0.244444],
      // empty BOM: readiness 0; no bonus can lift a zero (multiplicative by design)
      [9, 'fx-empty', 0],
    ]);
  });

  it('every score is exactly the product of its own displayed breakdown factors', () => {
    for (const entry of rankProspects(db, CONFIG, 'pocket').entries) {
      const b = entry.breakdown;
      const product =
        b.readiness.value *
        b.confidence.factor *
        b.systemMateCore.factor *
        b.cpuSoundComplete.factor;
      expect(entry.score, entry.systemId).toBe(Math.round(product * 1e6) / 1e6);
    }
  });

  it('explains fx-symmetric in full: weights, routes, mate and bonuses', () => {
    const entry = rankProspects(db, CONFIG, 'pocket').entries.find(
      (candidate) => candidate.systemId === 'fx-symmetric',
    );
    expect(entry).toBeDefined();
    expect(entry?.systemName).toBe('FX symmetric');
    expect(entry?.breakdown).toEqual({
      // z80(2) + sn76489(2) + ym2612(2) + sega-315-5011(5) = 11; satisfied
      // 2 + 2 + 2x0.9(equivalent credit) = 5.8; no unmapped devices.
      readiness: {
        chipWeight: 11,
        satisfiedWeight: 5.8,
        unmappedWeight: 0,
        totalWeight: 11,
        value: 0.527273,
      },
      chips: {
        total: 4,
        satisfied: 3,
        byBand: {
          hard: { satisfied: 0, missing: 1 },
          medium: { satisfied: 3, missing: 0 },
          soft: { satisfied: 0, missing: 0 },
        },
        missing: [{ chipId: 'sega-315-5011', band: 'hard', weight: 5 }],
        viaEdge: [{ chipId: 'ym2612', via: 'equivalent', providerChipId: 'ym3438', credit: 0.9 }],
      },
      unmappedDevices: { count: 0, weightEach: 4 },
      confidence: { level: 'medium', factor: 0.85 },
      // Its own core lives on mister, so on pocket the system is its own mate.
      systemMateCore: { applied: true, factor: 1.1, mateSystemId: 'fx-symmetric', sharedChips: 4 },
      cpuSoundComplete: {
        applied: true,
        factor: 1.15,
        cpuChips: 1,
        soundChips: 2,
        missingChipIds: [],
      },
    });
  });

  it('excludes fx-symmetric on mister (core exists there) but keeps its mate influence', () => {
    const ranking = rankProspects(db, CONFIG, 'mister');
    expect(ranking.candidateCount).toBe(8);
    expect(ranking.entries.some((entry) => entry.systemId === 'fx-symmetric')).toBe(false);
    const miss = ranking.entries.find((entry) => entry.systemId === 'fx-68k-miss');
    expect(miss?.breakdown.systemMateCore).toEqual({
      applied: true,
      factor: 1.1,
      mateSystemId: 'fx-symmetric',
      sharedChips: 2,
    });
  });

  it('gates the cpu+sound bonus on the basis actually containing both', () => {
    // fx-68k-hit has both of its CPU sockets satisfied but no sound socket at all:
    // vacuous completeness must not earn the bonus — that is the thin-BOM trap again.
    const entry = rankProspects(db, CONFIG, 'pocket').entries.find(
      (candidate) => candidate.systemId === 'fx-68k-hit',
    );
    expect(entry?.breakdown.cpuSoundComplete).toEqual({
      applied: false,
      factor: 1,
      cpuChips: 2,
      soundChips: 0,
      missingChipIds: [],
    });
  });

  it('config moves the ranking: no code change, no schema change', () => {
    // Neutralize exactly the two knobs that demote thin catalogues...
    const flat: ProspectorConfig = {
      ...CONFIG,
      unmappedDeviceWeight: 0,
      confidenceFactor: { high: 1, medium: 1, low: 1 },
    };
    const before = rankProspects(db, CONFIG, 'pocket').entries;
    const after = rankProspects(db, flat, 'pocket').entries;

    // ...and the nominal-100% boards leap from mid-table to the top.
    expect(before.find((entry) => entry.systemId === 'fx-unmapped-low')?.rank).toBe(7);
    expect(after.find((entry) => entry.systemId === 'fx-unmapped-low')?.rank).toBe(2);
    expect(after.map((entry) => entry.systemId).slice(0, 2)).toEqual([
      'fx-unmapped-med',
      'fx-unmapped-low',
    ]);

    // Both hit 1.0 x 1.1 x 1.15 = 1.265 — a genuine tie, resolved by the explicit
    // tie-break (totalWeight DESC: 10 vs 8), never by row order.
    expect(after[0]?.score).toBe(1.265);
    expect(after[1]?.score).toBe(1.265);
    expect(after[0]?.breakdown.readiness.totalWeight).toBeGreaterThan(
      after[1]?.breakdown.readiness.totalWeight ?? Number.NaN,
    );
  });

  it('an all-zero weighting falls through to the bytewise system_id tie-break', () => {
    const zero: ProspectorConfig = {
      ...CONFIG,
      bandWeight: { hard: 0, medium: 0, soft: 0 },
      unmappedDeviceWeight: 0,
    };
    const entries = rankProspects(db, zero, 'pocket').entries;
    expect(entries.every((entry) => entry.score === 0)).toBe(true);
    expect(entries.map((entry) => entry.systemId)).toEqual([
      'fx-2a03',
      'fx-68k-hit',
      'fx-68k-miss',
      'fx-68k-notrans',
      'fx-empty',
      'fx-kind',
      'fx-symmetric',
      'fx-unmapped-low',
      'fx-unmapped-med',
    ]);
  });

  it('applies a limit after the total order and keeps ranks 1..n', () => {
    const full = rankProspects(db, CONFIG, 'pocket');
    const top = rankProspects(db, CONFIG, 'pocket', { limit: 3 });
    expect(top.candidateCount).toBe(9);
    expect(top.entries.map((entry) => entry.systemId)).toEqual(
      full.entries.slice(0, 3).map((entry) => entry.systemId),
    );
    expect(top.entries.map((entry) => entry.rank)).toEqual([1, 2, 3]);
  });

  it('is deterministic: two runs return deeply equal results', () => {
    expect(rankProspects(db, CONFIG, 'pocket')).toEqual(rankProspects(db, CONFIG, 'pocket'));
  });

  it('rejects an unknown platform, naming the known ones', () => {
    expect(() => rankProspects(db, CONFIG, 'de10-nano')).toThrow(
      /unknown fpga_platform 'de10-nano'; known: mister, pocket/,
    );
  });

  it('renders a deterministic report with every factor visible', () => {
    const report = formatProspectorReport(rankProspects(db, CONFIG, 'pocket', { limit: 3 }));
    expect(report).toContain("top 3 of 9 candidate systems on 'pocket'");
    expect(report).toContain('fx-unmapped-med');
    expect(report).toContain('mate:fx-symmetric');
    // The policy pointer, so a reviewer knows where the knobs live.
    expect(report).toContain('pipeline/config/prospector.json');
  });
});

describe('prospector config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bomsquad-prospector-'));
  const write = (name: string, value: unknown): string => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(value));
    return path;
  };
  // Re-read the file rather than reusing loadProspectorConfig()'s output, so the
  // mutation tests below start from the exact shipped shape.
  const shipped = (): Record<string, unknown> =>
    JSON.parse(readFileSync(PROSPECTOR_CONFIG_PATH, 'utf8')) as Record<string, unknown>;

  it('the shipped config loads, with every knob a finite number', () => {
    // No value is pinned: tuning pipeline/config/prospector.json must never break a
    // test — that is the whole point of policy-in-config.
    const config = loadProspectorConfig();
    expect(config.version).not.toBe('');
    for (const value of [
      config.bandWeight.hard,
      config.bandWeight.medium,
      config.bandWeight.soft,
      config.unmappedDeviceWeight,
      config.routeCredit.equivalent,
      config.routeCredit.provides,
      config.confidenceFactor.high,
      config.confidenceFactor.medium,
      config.confidenceFactor.low,
      config.bonus.systemMateCore,
      config.bonus.cpuSoundComplete,
      config.systemMateMinSharedChips,
    ]) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });

  it('a missing band weight fails loudly, naming file and field', () => {
    const config = shipped();
    const band = { ...(config['band_weight'] as Record<string, unknown>) };
    delete band['hard'];
    const path = write('missing-band.json', { ...config, band_weight: band });
    expect(() => loadProspectorConfig(path)).toThrow(/'band_weight\.hard' must be a finite number/);
  });

  it('a route credit above 1 is rejected: credit is a fraction of the band weight', () => {
    const config = shipped();
    const path = write('bad-credit.json', {
      ...config,
      route_credit: { equivalent: 0.9, provides: 1.5 },
    });
    expect(() => loadProspectorConfig(path)).toThrow(/'route_credit\.provides' must be <= 1/);
  });

  it('a zero mate threshold is rejected: sharing nothing is not mateship', () => {
    const config = shipped();
    const path = write('bad-mate.json', { ...config, system_mate_min_shared_chips: 0 });
    expect(() => loadProspectorConfig(path)).toThrow(/'system_mate_min_shared_chips' must be >= 1/);
  });
});
