/**
 * TASKS T6.3 — the Prospector ranking.
 *
 * `v_prospector` orders by `satisfied_share`, a plain ratio with two failure modes this
 * module exists to fix:
 *
 * 1. **A missing custom counts the same as a missing jellybean.** The real cost of an
 *    FPGA port is concentrated in the `hard`-band functions (taxonomy.md §5) — customs,
 *    protection, the video pipeline — yet the ratio weighs a missing CPS-B ASIC exactly
 *    like a missing EEPROM.
 * 2. **A thinly-catalogued board looks fully covered.** `toaplan-version2` reads 6/6
 *    satisfied while carrying six unmapped MAME devices — among them `gp9001vdp`, the
 *    board's entire video system. The share is 1.0 because most of the silicon is not in
 *    the denominator. PLAN §8 names this exact trap ("coverage % can mislead when the 1
 *    missing chip is the hard 20%").
 *
 * **The score.** Every catalogued socket is weighted by its function's `prospector_band`
 * (a config number per band), and every *unmapped device* enters the denominator at its
 * own config weight — unidentified silicon on an arcade PCB is far more often a
 * board-specific custom than a jellybean, so it is priced near `hard` rather than at
 * zero. That single term is what demotes a thin catalogue below a thorough one at the
 * same nominal share:
 *
 * ```
 * readiness = Σ bandWeight(chip) × routeCredit(route)          over catalogued sockets
 *             ───────────────────────────────────────────────
 *             Σ bandWeight(chip) + unmapped × unmappedWeight
 *
 * score     = readiness × confidenceFactor × mateFactor × cpuSoundFactor
 * ```
 *
 * **The band is a prior, not a measurement** (taxonomy.md §5, normative for this module):
 * it rides `chip_function`, never the part, so the score corroborates it with the
 * per-part signals the dataset actually has — the route each socket is satisfied by
 * (`self` earns full credit; `equivalent` and `provides` earn the config's discounted
 * credit, because a `provides` socket still implies adaptation work, coverage.md §1.3),
 * the system's unmapped-device count, and the coverage view's own `confidence` column.
 * Nothing here reads a band off an individual chip and treats it as that chip's measured
 * difficulty.
 *
 * **Bonuses and penalty** (TASKS T6.3): a multiplicative bonus when a system-mate — any
 * system sharing at least `system_mate_min_shared_chips` distinct chips, including the
 * system itself via a core on another platform — already has an `fpga_hdl` core; a bonus
 * when every CPU/MCU *and* every sound socket is satisfied (gated on the basis actually
 * containing at least one of each — vacuous completeness is precisely the thin-catalogue
 * trap again); and a penalty for `low`/`medium` confidence BOMs via `confidenceFactor`.
 * Multiplicative, so nothing can bonus its way up from zero readiness.
 *
 * **Query-time only.** Nothing is stored: the numbers come from the shipped views
 * (`v_prospector`, `v_system_chip_coverage`, `v_system_chip_effective`, `v_system_core`)
 * joined to `chip_function.prospector_band` at query time, and every constant comes from
 * `pipeline/config/prospector.json`. Retuning the ranking is a config edit — no code, no
 * schema (proved in `test/prospector.test.ts`).
 *
 * **The breakdown is interface, not debug output.** T7.7 renders it per board, so
 * {@link ScoreBreakdown} carries every factor at the value actually applied:
 * `score = readiness.value × confidence.factor × systemMateCore.factor ×
 * cpuSoundComplete.factor`, exactly, after {@link round6}.
 *
 * **Determinism** (standing rule 2): the order is total — score descending, then
 * `totalWeight` descending (the more thoroughly catalogued board first), then
 * `system_id` bytewise. No tie is left to row order.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { DatabaseSync } from 'node:sqlite';

import { REPO_ROOT } from '../mame/config.js';
import { compareBytes } from '../db/rowfiles.js';

export const PROSPECTOR_CONFIG_PATH = join(REPO_ROOT, 'pipeline', 'config', 'prospector.json');

export type ProspectorBand = 'hard' | 'medium' | 'soft';
export type ConfidenceLevel = 'high' | 'medium' | 'low';
export type EdgeRoute = 'equivalent' | 'provides';

/** Every scoring knob. All numeric policy lives in `pipeline/config/prospector.json`. */
export interface ProspectorConfig {
  readonly version: string;
  /** Weight of one catalogued socket, by its function's `prospector_band`. */
  readonly bandWeight: Readonly<Record<ProspectorBand, number>>;
  /**
   * Weight of one unmapped MAME device in the denominator. Unidentified silicon is
   * treated as probably-hard, not as absent — this is the thin-catalogue demotion.
   */
  readonly unmappedDeviceWeight: number;
  /**
   * Credit earned by a socket satisfied through a `chip_equivalence` edge, in [0, 1].
   * A `self` route always earns 1.0 — an implementation naming the part is an observed
   * fact (coverage.md §4.2), not a tunable claim.
   */
  readonly routeCredit: Readonly<Record<EdgeRoute, number>>;
  /** Multiplier per `v_system_coverage_by_kind.confidence` level, in [0, 1]. */
  readonly confidenceFactor: Readonly<Record<ConfidenceLevel, number>>;
  readonly bonus: {
    /** Added to 1 when a system-mate (or this system, elsewhere) has a core. */
    readonly systemMateCore: number;
    /** Added to 1 when every CPU/MCU and every sound socket is satisfied. */
    readonly cpuSoundComplete: number;
  };
  /** Distinct shared chips required before another system counts as a mate. */
  readonly systemMateMinSharedChips: number;
}

export interface MissingChip {
  readonly chipId: string;
  readonly band: ProspectorBand;
  /** The band weight it holds in the denominator — what implementing it would earn. */
  readonly weight: number;
}

/** A socket satisfied through a curated substitution claim rather than its own HDL. */
export interface EdgeSatisfiedChip {
  readonly chipId: string;
  readonly via: EdgeRoute;
  readonly providerChipId: string;
  /** The route credit applied, from config. */
  readonly credit: number;
}

export interface BandCount {
  readonly satisfied: number;
  readonly missing: number;
}

/** The full explanation of one score. T7.7 renders this; it is interface, not debug. */
export interface ScoreBreakdown {
  readonly readiness: {
    /** Σ bandWeight over the catalogued basis. */
    readonly chipWeight: number;
    /** Σ bandWeight × routeCredit over satisfied sockets. */
    readonly satisfiedWeight: number;
    /** unmappedDevices.count × unmappedDevices.weightEach. */
    readonly unmappedWeight: number;
    /** chipWeight + unmappedWeight — the honest denominator. */
    readonly totalWeight: number;
    /** satisfiedWeight / totalWeight, or 0 when the denominator is 0. */
    readonly value: number;
  };
  readonly chips: {
    readonly total: number;
    readonly satisfied: number;
    readonly byBand: Readonly<Record<ProspectorBand, BandCount>>;
    /** Unsatisfied sockets, heaviest first — the work list. */
    readonly missing: readonly MissingChip[];
    /** Sockets covered by substitution, so the UI can badge the claim. */
    readonly viaEdge: readonly EdgeSatisfiedChip[];
  };
  readonly unmappedDevices: {
    readonly count: number;
    readonly weightEach: number;
  };
  readonly confidence: {
    readonly level: ConfidenceLevel;
    /** The multiplier actually applied. */
    readonly factor: number;
  };
  readonly systemMateCore: {
    readonly applied: boolean;
    /** 1 when not applied; 1 + bonus when applied. */
    readonly factor: number;
    /** The mate with the largest chip overlap; ties resolve to the bytewise-first id. */
    readonly mateSystemId: string | null;
    readonly sharedChips: number;
  };
  readonly cpuSoundComplete: {
    readonly applied: boolean;
    /** 1 when not applied; 1 + bonus when applied. */
    readonly factor: number;
    readonly cpuChips: number;
    readonly soundChips: number;
    /** CPU/MCU/sound sockets still unsatisfied, bytewise by chip id. */
    readonly missingChipIds: readonly string[];
  };
}

export interface ProspectorEntry {
  /** 1-based position in the total order. */
  readonly rank: number;
  readonly platformId: string;
  readonly systemId: string;
  readonly systemName: string;
  /** readiness × confidence × mate × cpu+sound, rounded to 6 decimals. */
  readonly score: number;
  readonly breakdown: ScoreBreakdown;
}

export interface ProspectorRanking {
  readonly platformId: string;
  /** Systems with no core on this platform — the rows ranked, before any limit. */
  readonly candidateCount: number;
  readonly entries: readonly ProspectorEntry[];
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

interface NumberRule {
  readonly min?: number;
  readonly max?: number;
  readonly integer?: boolean;
}

function requireNumber(
  source: Record<string, unknown>,
  key: string,
  path: string,
  where: string,
  rule: NumberRule = {},
): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${path}: '${where}' must be a finite number`);
  }
  if (rule.integer === true && !Number.isInteger(value)) {
    throw new Error(`${path}: '${where}' must be an integer`);
  }
  if (rule.min !== undefined && value < rule.min) {
    throw new Error(`${path}: '${where}' must be >= ${rule.min}`);
  }
  if (rule.max !== undefined && value > rule.max) {
    throw new Error(`${path}: '${where}' must be <= ${rule.max}`);
  }
  return value;
}

/**
 * Reads and validates the scoring policy. Fails loudly, naming file and field — a knob
 * that stops parsing must never silently zero a term of the score.
 */
export function loadProspectorConfig(path: string = PROSPECTOR_CONFIG_PATH): ProspectorConfig {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isPlainObject(raw)) throw new Error(`${path}: expected a JSON object`);

  const version = raw['version'];
  if (typeof version !== 'string' || version.trim() === '') {
    throw new Error(`${path}: 'version' must be a non-empty string`);
  }

  const band = requireObject(raw, 'band_weight', path);
  const credit = requireObject(raw, 'route_credit', path);
  const confidence = requireObject(raw, 'confidence_factor', path);
  const bonus = requireObject(raw, 'bonus', path);
  const weight = { min: 0 };
  const fraction = { min: 0, max: 1 };

  return {
    version,
    bandWeight: {
      hard: requireNumber(band, 'hard', path, 'band_weight.hard', weight),
      medium: requireNumber(band, 'medium', path, 'band_weight.medium', weight),
      soft: requireNumber(band, 'soft', path, 'band_weight.soft', weight),
    },
    unmappedDeviceWeight: requireNumber(
      raw,
      'unmapped_device_weight',
      path,
      'unmapped_device_weight',
      weight,
    ),
    routeCredit: {
      equivalent: requireNumber(credit, 'equivalent', path, 'route_credit.equivalent', fraction),
      provides: requireNumber(credit, 'provides', path, 'route_credit.provides', fraction),
    },
    confidenceFactor: {
      high: requireNumber(confidence, 'high', path, 'confidence_factor.high', fraction),
      medium: requireNumber(confidence, 'medium', path, 'confidence_factor.medium', fraction),
      low: requireNumber(confidence, 'low', path, 'confidence_factor.low', fraction),
    },
    bonus: {
      systemMateCore: requireNumber(bonus, 'system_mate_core', path, 'bonus.system_mate_core', {
        min: 0,
      }),
      cpuSoundComplete: requireNumber(
        bonus,
        'cpu_sound_complete',
        path,
        'bonus.cpu_sound_complete',
        { min: 0 },
      ),
    },
    systemMateMinSharedChips: requireNumber(
      raw,
      'system_mate_min_shared_chips',
      path,
      'system_mate_min_shared_chips',
      { min: 1, integer: true },
    ),
  };
}

// ---------------------------------------------------------------------------
// The queries
// ---------------------------------------------------------------------------

/**
 * `v_prospector` is by definition about FPGA cores (schema.sql §7b — the one view in the
 * schema that names a kind), so the per-chip slice this module joins to it fixes the same
 * literal. This is definitional alignment with the view, not a policy knob.
 */
const KIND = 'fpga_hdl';

/**
 * One socket per (system, chip) with its band weight and route credit, both bound from
 * config at query time. Shared verbatim by the ranking aggregate and the per-system
 * detail query so the two can never disagree on a predicate. The `is_cpu` / `is_sound`
 * flags select taxonomy *branches* by their own slug grammar; the banned pattern
 * (taxonomy.md §5, "band by row, never by branch prefix") is inferring a *band* from a
 * prefix, which this is not — the band always arrives via the `chip_function` join.
 */
const DETAIL_CTE = `
  detail AS (
    SELECT cc.system_id,
           cc.chip_id,
           cc.evidence_rank,
           cc.satisfied_via,
           cc.provider_chip_id,
           cf.prospector_band AS band,
           CASE cf.prospector_band
             WHEN 'hard'   THEN :band_hard
             WHEN 'medium' THEN :band_medium
             ELSE               :band_soft
           END AS weight,
           CASE cc.evidence_rank
             WHEN 1 THEN 1.0
             WHEN 2 THEN :credit_equivalent
             WHEN 3 THEN :credit_provides
             ELSE        0.0
           END AS credit,
           CASE WHEN c.function_id IN ('cpu', 'mcu') THEN 1 ELSE 0 END AS is_cpu,
           CASE WHEN c.function_id GLOB 'sound-*'    THEN 1 ELSE 0 END AS is_sound
    FROM v_system_chip_coverage cc
    JOIN chip c           ON c.chip_id      = cc.chip_id
    JOIN chip_function cf ON cf.function_id = c.function_id
    WHERE cc.kind_id = '${KIND}'
  )`;

const RANK_SQL = `
WITH ${DETAIL_CTE},
agg AS (
  SELECT system_id,
         SUM(weight)          AS chip_weight,
         SUM(weight * credit) AS satisfied_weight,
         SUM(CASE WHEN band = 'hard'   AND evidence_rank < 4 THEN 1 ELSE 0 END) AS hard_satisfied,
         SUM(CASE WHEN band = 'hard'   AND evidence_rank = 4 THEN 1 ELSE 0 END) AS hard_missing,
         SUM(CASE WHEN band = 'medium' AND evidence_rank < 4 THEN 1 ELSE 0 END) AS medium_satisfied,
         SUM(CASE WHEN band = 'medium' AND evidence_rank = 4 THEN 1 ELSE 0 END) AS medium_missing,
         SUM(CASE WHEN band = 'soft'   AND evidence_rank < 4 THEN 1 ELSE 0 END) AS soft_satisfied,
         SUM(CASE WHEN band = 'soft'   AND evidence_rank = 4 THEN 1 ELSE 0 END) AS soft_missing,
         SUM(is_cpu)                                                            AS cpu_chips,
         SUM(CASE WHEN is_cpu   = 1 AND evidence_rank < 4 THEN 1 ELSE 0 END)    AS cpu_satisfied,
         SUM(is_sound)                                                          AS sound_chips,
         SUM(CASE WHEN is_sound = 1 AND evidence_rank < 4 THEN 1 ELSE 0 END)    AS sound_satisfied
  FROM detail
  GROUP BY system_id
),
effective AS (SELECT DISTINCT system_id, chip_id FROM v_system_chip_effective),
-- A mate is any system sharing >= :mate_min_shared_chips distinct chips with this one
-- that already has an fpga_hdl core on ANY platform: the HDL and the porting experience
-- exist, whatever box they currently run on. The system itself qualifies through a core
-- on another platform — v_prospector only emits rows where *this* platform lacks one.
mate AS (
  SELECT a.system_id, b.system_id AS mate_system_id, COUNT(*) AS shared_chips
  FROM effective a
  JOIN effective b ON b.chip_id = a.chip_id
  WHERE EXISTS (SELECT 1 FROM v_system_core f
                WHERE f.kind_id = '${KIND}' AND f.system_id = b.system_id)
  GROUP BY a.system_id, b.system_id
  HAVING COUNT(*) >= :mate_min_shared_chips
),
best_mate AS (
  SELECT system_id, mate_system_id, shared_chips
  FROM (SELECT system_id, mate_system_id, shared_chips,
               ROW_NUMBER() OVER (PARTITION BY system_id
                                  ORDER BY shared_chips DESC, mate_system_id ASC) AS pick
        FROM mate)
  WHERE pick = 1
)
SELECT p.system_id,
       s.name                           AS system_name,
       p.chips_total,
       p.chips_satisfied,
       p.unmapped_device_count,
       p.confidence,
       COALESCE(a.chip_weight,      0)  AS chip_weight,
       COALESCE(a.satisfied_weight, 0)  AS satisfied_weight,
       COALESCE(a.hard_satisfied,   0)  AS hard_satisfied,
       COALESCE(a.hard_missing,     0)  AS hard_missing,
       COALESCE(a.medium_satisfied, 0)  AS medium_satisfied,
       COALESCE(a.medium_missing,   0)  AS medium_missing,
       COALESCE(a.soft_satisfied,   0)  AS soft_satisfied,
       COALESCE(a.soft_missing,     0)  AS soft_missing,
       COALESCE(a.cpu_chips,        0)  AS cpu_chips,
       COALESCE(a.cpu_satisfied,    0)  AS cpu_satisfied,
       COALESCE(a.sound_chips,      0)  AS sound_chips,
       COALESCE(a.sound_satisfied,  0)  AS sound_satisfied,
       m.mate_system_id,
       COALESCE(m.shared_chips,     0)  AS mate_shared_chips
FROM v_prospector p
JOIN system s         ON s.system_id = p.system_id
LEFT JOIN agg a       ON a.system_id = p.system_id
LEFT JOIN best_mate m ON m.system_id = p.system_id
WHERE p.platform_id = :platform_id
ORDER BY p.system_id`;

const CHIP_SQL = `
WITH ${DETAIL_CTE}
SELECT chip_id, band, weight, credit, evidence_rank, satisfied_via, provider_chip_id,
       is_cpu, is_sound
FROM detail
WHERE system_id = :system_id
ORDER BY chip_id`;

// ---------------------------------------------------------------------------
// Row access
// ---------------------------------------------------------------------------

type SqlRow = Record<string, unknown>;

function num(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value === 'bigint') return Number(value);
  if (typeof value !== 'number') {
    throw new Error(`prospector: column '${key}' returned ${typeof value}, expected number`);
  }
  return value;
}

function str(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new Error(`prospector: column '${key}' returned ${typeof value}, expected string`);
  }
  return value;
}

function strOrNull(row: SqlRow, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new Error(`prospector: column '${key}' returned ${typeof value}, expected string`);
  }
  return value;
}

function confidenceLevel(value: string): ConfidenceLevel {
  if (value === 'high' || value === 'medium' || value === 'low') return value;
  throw new Error(`prospector: unexpected confidence level '${value}'`);
}

function bandOf(value: string): ProspectorBand {
  if (value === 'hard' || value === 'medium' || value === 'soft') return value;
  throw new Error(`prospector: unexpected prospector_band '${value}'`);
}

function edgeRoute(value: string): EdgeRoute {
  if (value === 'equivalent' || value === 'provides') return value;
  throw new Error(`prospector: unexpected satisfied_via '${value}' for an edge route`);
}

/**
 * Scores are IEEE-754 products of config values; six decimals is far past any real
 * distinction and keeps the published breakdown byte-stable. The breakdown reproduces
 * the score exactly because the *rounded* readiness is what the factors multiply.
 */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

interface ScoredRow {
  readonly row: SqlRow;
  readonly systemId: string;
  readonly score: number;
  readonly totalWeight: number;
  readonly readinessValue: number;
  readonly confidence: ConfidenceLevel;
  readonly confidenceFactor: number;
  readonly mateSystemId: string | null;
  readonly mateFactor: number;
  readonly cpuSoundApplied: boolean;
  readonly cpuSoundFactor: number;
}

export interface RankOptions {
  /** Entries to return after ordering. Omit for all. */
  readonly limit?: number;
}

/**
 * Ranks every `v_prospector` candidate on one platform. Deterministic total order:
 * score DESC, then `totalWeight` DESC (at equal scores the more thoroughly catalogued
 * board outranks the thinner one), then `system_id` bytewise ASC.
 */
export function rankProspects(
  db: DatabaseSync,
  config: ProspectorConfig,
  platformId: string,
  options: RankOptions = {},
): ProspectorRanking {
  const platforms = db
    .prepare('SELECT platform_id FROM fpga_platform ORDER BY platform_id')
    .all()
    .map((row) => str(row as SqlRow, 'platform_id'));
  if (!platforms.includes(platformId)) {
    throw new Error(
      `prospector: unknown fpga_platform '${platformId}'; known: ${platforms.join(', ')}`,
    );
  }
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1)) {
    throw new Error(`prospector: limit must be a positive integer, got ${options.limit}`);
  }

  const weightParams = {
    band_hard: config.bandWeight.hard,
    band_medium: config.bandWeight.medium,
    band_soft: config.bandWeight.soft,
    credit_equivalent: config.routeCredit.equivalent,
    credit_provides: config.routeCredit.provides,
  };

  const rows = db.prepare(RANK_SQL).all({
    ...weightParams,
    mate_min_shared_chips: config.systemMateMinSharedChips,
    platform_id: platformId,
  }) as SqlRow[];

  const scored: ScoredRow[] = rows.map((row) => {
    const chipWeight = num(row, 'chip_weight');
    const unmappedWeight = num(row, 'unmapped_device_count') * config.unmappedDeviceWeight;
    const totalWeight = chipWeight + unmappedWeight;
    const readinessValue = round6(
      totalWeight === 0 ? 0 : num(row, 'satisfied_weight') / totalWeight,
    );

    const confidence = confidenceLevel(str(row, 'confidence'));
    const confidenceFactor = config.confidenceFactor[confidence];

    const mateSystemId = strOrNull(row, 'mate_system_id');
    const mateFactor = mateSystemId === null ? 1 : 1 + config.bonus.systemMateCore;

    const cpuChips = num(row, 'cpu_chips');
    const soundChips = num(row, 'sound_chips');
    const cpuSoundApplied =
      cpuChips >= 1 &&
      soundChips >= 1 &&
      num(row, 'cpu_satisfied') === cpuChips &&
      num(row, 'sound_satisfied') === soundChips;
    const cpuSoundFactor = cpuSoundApplied ? 1 + config.bonus.cpuSoundComplete : 1;

    return {
      row,
      systemId: str(row, 'system_id'),
      score: round6(readinessValue * confidenceFactor * mateFactor * cpuSoundFactor),
      totalWeight,
      readinessValue,
      confidence,
      confidenceFactor,
      mateSystemId,
      mateFactor,
      cpuSoundApplied,
      cpuSoundFactor,
    };
  });

  scored.sort(
    (a, b) =>
      b.score - a.score || b.totalWeight - a.totalWeight || compareBytes(a.systemId, b.systemId),
  );

  const limited = options.limit === undefined ? scored : scored.slice(0, options.limit);
  const detailStatement = db.prepare(CHIP_SQL);

  const entries = limited.map((entry, index): ProspectorEntry => {
    const { row } = entry;
    const details = detailStatement.all({ ...weightParams, system_id: entry.systemId }) as SqlRow[];

    const missing = details
      .filter((detail) => num(detail, 'evidence_rank') === 4)
      .map((detail): MissingChip => ({
        chipId: str(detail, 'chip_id'),
        band: bandOf(str(detail, 'band')),
        weight: num(detail, 'weight'),
      }))
      .sort((a, b) => b.weight - a.weight || compareBytes(a.chipId, b.chipId));

    const viaEdge = details
      .filter((detail) => {
        const rank = num(detail, 'evidence_rank');
        return rank === 2 || rank === 3;
      })
      .map((detail): EdgeSatisfiedChip => ({
        chipId: str(detail, 'chip_id'),
        via: edgeRoute(str(detail, 'satisfied_via')),
        providerChipId: str(detail, 'provider_chip_id'),
        credit: num(detail, 'credit'),
      }));

    const cpuSoundMissing = details
      .filter(
        (detail) =>
          num(detail, 'evidence_rank') === 4 &&
          (num(detail, 'is_cpu') === 1 || num(detail, 'is_sound') === 1),
      )
      .map((detail) => str(detail, 'chip_id'));

    return {
      rank: index + 1,
      platformId,
      systemId: entry.systemId,
      systemName: str(row, 'system_name'),
      score: entry.score,
      breakdown: {
        readiness: {
          chipWeight: round6(num(row, 'chip_weight')),
          satisfiedWeight: round6(num(row, 'satisfied_weight')),
          unmappedWeight: round6(entry.totalWeight - num(row, 'chip_weight')),
          totalWeight: round6(entry.totalWeight),
          value: entry.readinessValue,
        },
        chips: {
          total: num(row, 'chips_total'),
          satisfied: num(row, 'chips_satisfied'),
          byBand: {
            hard: {
              satisfied: num(row, 'hard_satisfied'),
              missing: num(row, 'hard_missing'),
            },
            medium: {
              satisfied: num(row, 'medium_satisfied'),
              missing: num(row, 'medium_missing'),
            },
            soft: {
              satisfied: num(row, 'soft_satisfied'),
              missing: num(row, 'soft_missing'),
            },
          },
          missing,
          viaEdge,
        },
        unmappedDevices: {
          count: num(row, 'unmapped_device_count'),
          weightEach: config.unmappedDeviceWeight,
        },
        confidence: {
          level: entry.confidence,
          factor: entry.confidenceFactor,
        },
        systemMateCore: {
          applied: entry.mateSystemId !== null,
          factor: entry.mateFactor,
          mateSystemId: entry.mateSystemId,
          sharedChips: num(row, 'mate_shared_chips'),
        },
        cpuSoundComplete: {
          applied: entry.cpuSoundApplied,
          factor: entry.cpuSoundFactor,
          cpuChips: num(row, 'cpu_chips'),
          soundChips: num(row, 'sound_chips'),
          missingChipIds: cpuSoundMissing,
        },
      },
    };
  });

  return { platformId, candidateCount: scored.length, entries };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const one = (value: number): string => value.toFixed(1);

function flags(entry: ProspectorEntry): string {
  const parts: string[] = [];
  if (entry.breakdown.systemMateCore.applied) {
    parts.push(`mate:${String(entry.breakdown.systemMateCore.mateSystemId)}`);
  }
  if (entry.breakdown.cpuSoundComplete.applied) parts.push('cpu+sound');
  return parts.length === 0 ? '-' : parts.join(' ');
}

function gaps(entry: ProspectorEntry, limit = 3): string {
  const { missing } = entry.breakdown.chips;
  const shown = missing
    .slice(0, limit)
    .map((chip) => `${chip.chipId}(${chip.band})`)
    .join(' ');
  const more = missing.length - limit;
  const suffix = more > 0 ? ` +${more}` : '';
  return missing.length === 0 ? '-' : `${shown}${suffix}`;
}

/** The reviewable table: one line per entry, every factor visible, fully deterministic. */
export function formatProspectorReport(ranking: ProspectorRanking): string {
  const lines = [
    `prospector: top ${ranking.entries.length} of ${ranking.candidateCount} candidate systems ` +
      `on '${ranking.platformId}' (kind ${KIND})`,
    'score = readiness x confidence x bonuses; policy: pipeline/config/prospector.json',
    '',
    '   #  score     ready            chips  unmap  conf    system',
  ];
  for (const entry of ranking.entries) {
    const b = entry.breakdown;
    const ready = `${one(b.readiness.satisfiedWeight)}/${one(b.readiness.totalWeight)}`;
    lines.push(
      `  ${String(entry.rank).padStart(2)}  ${entry.score.toFixed(6)}  ` +
        `${ready.padEnd(15)}  ${`${b.chips.satisfied}/${b.chips.total}`.padEnd(5)}  ` +
        `${String(b.unmappedDevices.count).padEnd(5)}  ${b.confidence.level.padEnd(6)}  ` +
        entry.systemId,
    );
    lines.push(`      ${flags(entry)} | missing: ${gaps(entry)}`);
  }
  return `${lines.join('\n')}\n`;
}
