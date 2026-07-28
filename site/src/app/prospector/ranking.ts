/**
 * T7.7 — the Prospector's ranking, client side.
 *
 * **This is a port, not a second ranking.** `pipeline/src/prospector/rank.ts` (T6.3)
 * owns the definition of the score; it runs on `node:sqlite` inside the pipeline and
 * cannot be imported from a browser bundle. So the two SQL statements and the
 * arithmetic that turns their rows into a score are reproduced here *verbatim*, and
 * `site/tools/verify-prospector-parity.mjs` runs both implementations over the same
 * database and fails on any difference in any field of any entry. See
 * `ranking.spec.ts` and the tool's header for what "verbatim" is checked to mean.
 *
 * Three deliberate differences, none of which touch a number:
 *
 * 1. **One detail query instead of N.** The pipeline prepares `CHIP_SQL` and runs it
 *    once per ranked system; the browser runs {@link PROSPECTOR_DETAIL_SQL} once for
 *    every system and groups by `system_id` in TypeScript. Same CTE, same predicates,
 *    same per-row values — the whole list needs its `missing[]` inline anyway, so N
 *    round trips through the wasm boundary would buy nothing.
 * 2. **Extra display columns.** `RANK_SQL`'s `SELECT` list gains `s.kind_id`,
 *    `s.manufacturer_id` and `s.year_introduced` so the view can filter and label
 *    without a second statement. Projection only; nothing computed reads them.
 * 3. **No `limit`.** The view ranks every candidate and pages in the UI, because a
 *    filter must not be able to change what rank a board holds.
 *
 * All scoring policy lives in `pipeline/config/prospector.json` and reaches this
 * module through `prospector-config.generated.ts`, which `site/tools/generate-db-types.mjs`
 * regenerates and `schema-types.spec.ts` checks for drift. There is no second copy of
 * a weight anywhere in `site/`.
 */

export type ProspectorBand = 'hard' | 'medium' | 'soft';
export type ConfidenceLevel = 'high' | 'medium' | 'low';
export type EdgeRoute = 'equivalent' | 'provides';

/** Every scoring knob, exactly as `rank.ts` shapes it. */
export interface ProspectorConfig {
  readonly version: string;
  readonly bandWeight: Readonly<Record<ProspectorBand, number>>;
  readonly unmappedDeviceWeight: number;
  readonly routeCredit: Readonly<Record<EdgeRoute, number>>;
  readonly confidenceFactor: Readonly<Record<ConfidenceLevel, number>>;
  readonly bonus: {
    readonly systemMateCore: number;
    readonly cpuSoundComplete: number;
  };
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
  readonly credit: number;
}

export interface BandCount {
  readonly satisfied: number;
  readonly missing: number;
}

/** The full explanation of one score. The view renders this; it is interface, not debug. */
export interface ScoreBreakdown {
  readonly readiness: {
    readonly chipWeight: number;
    readonly satisfiedWeight: number;
    readonly unmappedWeight: number;
    readonly totalWeight: number;
    readonly value: number;
  };
  readonly chips: {
    readonly total: number;
    readonly satisfied: number;
    readonly byBand: Readonly<Record<ProspectorBand, BandCount>>;
    readonly missing: readonly MissingChip[];
    readonly viaEdge: readonly EdgeSatisfiedChip[];
  };
  readonly unmappedDevices: {
    readonly count: number;
    readonly weightEach: number;
  };
  readonly confidence: {
    readonly level: ConfidenceLevel;
    readonly factor: number;
  };
  readonly systemMateCore: {
    readonly applied: boolean;
    readonly factor: number;
    readonly mateSystemId: string | null;
    readonly sharedChips: number;
  };
  readonly cpuSoundComplete: {
    readonly applied: boolean;
    readonly factor: number;
    readonly cpuChips: number;
    readonly soundChips: number;
    readonly missingChipIds: readonly string[];
  };
}

export interface ProspectorEntry {
  readonly rank: number;
  readonly platformId: string;
  readonly systemId: string;
  readonly systemName: string;
  readonly score: number;
  readonly breakdown: ScoreBreakdown;
  /** Projection-only, for the view's filters and labels. Not part of the score. */
  readonly systemKindId: string;
  readonly manufacturerId: string | null;
  readonly yearIntroduced: number | null;
}

export interface ProspectorRanking {
  readonly platformId: string;
  readonly candidateCount: number;
  readonly entries: readonly ProspectorEntry[];
}

/**
 * `v_prospector` is by definition about FPGA cores (schema.sql §7b — the one view in
 * the schema that names a kind), so the per-chip slice joined to it fixes the same
 * literal. Definitional alignment with the view, not a policy knob.
 */
export const PROSPECTOR_KIND = 'fpga_hdl';

/**
 * One socket per (system, chip) with its band weight and route credit, both bound from
 * config at query time. Shared verbatim by the ranking aggregate and the detail query
 * so the two can never disagree on a predicate.
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
    WHERE cc.kind_id = '${PROSPECTOR_KIND}'
  )`;

/** `rank.ts`'s `RANK_SQL`, plus three projection-only columns for the view. */
export const PROSPECTOR_RANK_SQL = `
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
mate AS (
  SELECT a.system_id, b.system_id AS mate_system_id, COUNT(*) AS shared_chips
  FROM effective a
  JOIN effective b ON b.chip_id = a.chip_id
  WHERE EXISTS (SELECT 1 FROM v_system_core f
                WHERE f.kind_id = '${PROSPECTOR_KIND}' AND f.system_id = b.system_id)
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
       s.kind_id                        AS system_kind_id,
       s.manufacturer_id,
       s.year_introduced,
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

/**
 * `rank.ts`'s `CHIP_SQL` with the `system_id` equality lifted into the `ORDER BY`.
 *
 * The pipeline runs that statement once per ranked system; one statement for all of
 * them returns the same rows with the same values, and `system_id, chip_id` ordering
 * makes the grouped result identical to N filtered results concatenated.
 */
export const PROSPECTOR_DETAIL_SQL = `
WITH ${DETAIL_CTE}
SELECT system_id, chip_id, band, weight, credit, evidence_rank, satisfied_via,
       provider_chip_id, is_cpu, is_sound
FROM detail
ORDER BY system_id, chip_id`;

/** One row of {@link PROSPECTOR_RANK_SQL}. */
export interface ProspectorRankRow {
  readonly system_id: string;
  readonly system_name: string;
  readonly system_kind_id: string;
  readonly manufacturer_id: string | null;
  readonly year_introduced: number | null;
  readonly chips_total: number;
  readonly chips_satisfied: number;
  readonly unmapped_device_count: number;
  readonly confidence: string;
  readonly chip_weight: number;
  readonly satisfied_weight: number;
  readonly hard_satisfied: number;
  readonly hard_missing: number;
  readonly medium_satisfied: number;
  readonly medium_missing: number;
  readonly soft_satisfied: number;
  readonly soft_missing: number;
  readonly cpu_chips: number;
  readonly cpu_satisfied: number;
  readonly sound_chips: number;
  readonly sound_satisfied: number;
  readonly mate_system_id: string | null;
  readonly mate_shared_chips: number;
}

/** One row of {@link PROSPECTOR_DETAIL_SQL}. */
export interface ProspectorDetailRow {
  readonly system_id: string;
  readonly chip_id: string;
  readonly band: string;
  readonly weight: number;
  readonly credit: number;
  readonly evidence_rank: number;
  readonly satisfied_via: string;
  readonly provider_chip_id: string | null;
  readonly is_cpu: number;
  readonly is_sound: number;
}

/** Bindings the two statements above share. Bound from config, never inlined. */
export function weightParams(config: ProspectorConfig): Record<string, number> {
  return {
    ':band_hard': config.bandWeight.hard,
    ':band_medium': config.bandWeight.medium,
    ':band_soft': config.bandWeight.soft,
    ':credit_equivalent': config.routeCredit.equivalent,
    ':credit_provides': config.routeCredit.provides,
  };
}

export function rankParams(
  config: ProspectorConfig,
  platformId: string,
): Record<string, string | number> {
  return {
    ...weightParams(config),
    ':mate_min_shared_chips': config.systemMateMinSharedChips,
    ':platform_id': platformId,
  };
}

/**
 * Scores are IEEE-754 products of config values; six decimals is far past any real
 * distinction and keeps the published breakdown byte-stable. The breakdown reproduces
 * the score exactly because the *rounded* readiness is what the factors multiply.
 */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * `Buffer.compare(Buffer.from(a, 'utf8'), …)`, which is what the pipeline's tiebreak
 * uses and which there is no `Buffer` for here.
 *
 * Every `system_id` and `chip_id` the DDL admits is `[a-z0-9-]`, so `<` on the strings
 * would already agree — but the ordering is part of the ported contract, so it is the
 * bytes that get compared rather than an assumption about them.
 */
const utf8 = new TextEncoder();

export function compareBytes(a: string, b: string): number {
  const left = utf8.encode(a);
  const right = utf8.encode(b);
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference < 0 ? -1 : 1;
    }
  }
  return left.length === right.length ? 0 : left.length < right.length ? -1 : 1;
}

function confidenceLevel(value: string): ConfidenceLevel {
  if (value === 'high' || value === 'medium' || value === 'low') {
    return value;
  }
  throw new Error(`prospector: unexpected confidence level '${value}'`);
}

function bandOf(value: string): ProspectorBand {
  if (value === 'hard' || value === 'medium' || value === 'soft') {
    return value;
  }
  throw new Error(`prospector: unexpected prospector_band '${value}'`);
}

function edgeRoute(value: string): EdgeRoute {
  if (value === 'equivalent' || value === 'provides') {
    return value;
  }
  throw new Error(`prospector: unexpected satisfied_via '${value}' for an edge route`);
}

interface ScoredRow {
  readonly row: ProspectorRankRow;
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

/** `ProspectorDetailRow`s grouped by `system_id`, in the order the statement returned them. */
export function groupDetails(
  rows: readonly ProspectorDetailRow[],
): ReadonlyMap<string, readonly ProspectorDetailRow[]> {
  const grouped = new Map<string, ProspectorDetailRow[]>();
  for (const row of rows) {
    const bucket = grouped.get(row.system_id);
    if (bucket === undefined) {
      grouped.set(row.system_id, [row]);
    } else {
      bucket.push(row);
    }
  }
  return grouped;
}

/**
 * Ranks every `v_prospector` candidate on one platform.
 *
 * Deterministic total order, identical to the pipeline's: score DESC, then
 * `totalWeight` DESC (at equal scores the more thoroughly catalogued board outranks
 * the thinner one), then `system_id` bytewise ASC. No tie is left to row order.
 */
export function rankProspects(
  rankRows: readonly ProspectorRankRow[],
  detailRows: readonly ProspectorDetailRow[],
  config: ProspectorConfig,
  platformId: string,
): ProspectorRanking {
  const scored: ScoredRow[] = rankRows.map((row) => {
    const chipWeight = row.chip_weight;
    const unmappedWeight = row.unmapped_device_count * config.unmappedDeviceWeight;
    const totalWeight = chipWeight + unmappedWeight;
    const readinessValue = round6(totalWeight === 0 ? 0 : row.satisfied_weight / totalWeight);

    const confidence = confidenceLevel(row.confidence);
    const confidenceFactor = config.confidenceFactor[confidence];

    const mateSystemId = row.mate_system_id;
    const mateFactor = mateSystemId === null ? 1 : 1 + config.bonus.systemMateCore;

    const cpuChips = row.cpu_chips;
    const soundChips = row.sound_chips;
    const cpuSoundApplied =
      cpuChips >= 1 &&
      soundChips >= 1 &&
      row.cpu_satisfied === cpuChips &&
      row.sound_satisfied === soundChips;
    const cpuSoundFactor = cpuSoundApplied ? 1 + config.bonus.cpuSoundComplete : 1;

    return {
      row,
      systemId: row.system_id,
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

  const bySystem = groupDetails(detailRows);

  const entries = scored.map((entry, index): ProspectorEntry => {
    const { row } = entry;
    const details = bySystem.get(entry.systemId) ?? [];

    const missing = details
      .filter((detail) => detail.evidence_rank === 4)
      .map((detail): MissingChip => ({
        chipId: detail.chip_id,
        band: bandOf(detail.band),
        weight: detail.weight,
      }))
      .sort((a, b) => b.weight - a.weight || compareBytes(a.chipId, b.chipId));

    const viaEdge = details
      .filter((detail) => detail.evidence_rank === 2 || detail.evidence_rank === 3)
      .map((detail): EdgeSatisfiedChip => ({
        chipId: detail.chip_id,
        via: edgeRoute(detail.satisfied_via),
        providerChipId: detail.provider_chip_id ?? '',
        credit: detail.credit,
      }));

    const cpuSoundMissing = details
      .filter(
        (detail) => detail.evidence_rank === 4 && (detail.is_cpu === 1 || detail.is_sound === 1),
      )
      .map((detail) => detail.chip_id);

    return {
      rank: index + 1,
      platformId,
      systemId: entry.systemId,
      systemName: row.system_name,
      systemKindId: row.system_kind_id,
      manufacturerId: row.manufacturer_id,
      yearIntroduced: row.year_introduced,
      score: entry.score,
      breakdown: {
        readiness: {
          chipWeight: round6(row.chip_weight),
          satisfiedWeight: round6(row.satisfied_weight),
          unmappedWeight: round6(entry.totalWeight - row.chip_weight),
          totalWeight: round6(entry.totalWeight),
          value: entry.readinessValue,
        },
        chips: {
          total: row.chips_total,
          satisfied: row.chips_satisfied,
          byBand: {
            hard: { satisfied: row.hard_satisfied, missing: row.hard_missing },
            medium: { satisfied: row.medium_satisfied, missing: row.medium_missing },
            soft: { satisfied: row.soft_satisfied, missing: row.soft_missing },
          },
          missing,
          viaEdge,
        },
        unmappedDevices: {
          count: row.unmapped_device_count,
          weightEach: config.unmappedDeviceWeight,
        },
        confidence: { level: entry.confidence, factor: entry.confidenceFactor },
        systemMateCore: {
          applied: entry.mateSystemId !== null,
          factor: entry.mateFactor,
          mateSystemId: entry.mateSystemId,
          sharedChips: row.mate_shared_chips,
        },
        cpuSoundComplete: {
          applied: entry.cpuSoundApplied,
          factor: entry.cpuSoundFactor,
          cpuChips: row.cpu_chips,
          soundChips: row.sound_chips,
          missingChipIds: cpuSoundMissing,
        },
      },
    };
  });

  return { platformId, candidateCount: scored.length, entries };
}
