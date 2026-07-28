/**
 * The ONE hand-declared place in the data layer's type surface.
 *
 * Table row types are generated wholesale from `schemas/*.schema.json` — the JSON
 * Schemas are the single source of truth for which columns a table has and what
 * scalar each one holds, and `generate-db-types.mjs` cross-checks them against the
 * DDL so neither side can drift.
 *
 * **Views have no JSON Schema, and SQLite exposes no usable type metadata for
 * them.** `PRAGMA table_info(a_view)` reports `notnull = 0` for every column
 * regardless of the underlying DDL, and its `type` column is wrong often enough to
 * be dangerous: on the shipped database it calls `v_quality_warning.subject` and
 * `v_system_chip_coverage.system_id` `BLOB`, because it echoes whichever branch of a
 * `UNION` or `CASE` SQLite happened to bind. `StatementSync.columns()` is better —
 * it names an origin table and column for pass-through columns — but it is silent
 * for every computed column (`satisfied_share`, `confidence`, `evidence_rank`,
 * every literal in `v_quality_warning`), which is where the interesting types are.
 * There is no mechanical answer, so the answer is written down here, once.
 *
 * What that does *not* mean is "hand-maintained and hope":
 *
 * - `generate-db-types.mjs` applies `schemas/schema.sql` to a real SQLite database
 *   and asserts that this map lists **exactly** the columns each view has, **in the
 *   order the DDL declares them**. A renamed, added, removed or reordered view
 *   column fails the build. Only the *types* below are a judgment call; the names
 *   and the shape are the DDL's.
 * - `view-types.spec.ts` runs every view against a fixture database and asserts
 *   each declared type against the SQLite storage class actually returned, and that
 *   nothing declared non-nullable ever comes back NULL.
 *
 * Nullability rules used below, read off `schemas/schema.sql`:
 *
 * - a column projected straight from a `NOT NULL` table column is non-nullable;
 * - the same column reached through a `LEFT JOIN` is nullable;
 * - `COALESCE(x, y)` with a `NOT NULL` `y` is non-nullable;
 * - an aggregate over a `GROUP BY` group is non-nullable (the group is non-empty);
 *   a bare `SUM()` over a possibly-empty table is not, and is written `| null`.
 */

/**
 * Named unions the view interfaces share. Emitted ahead of the interfaces so a
 * consumer can `switch` on them and get exhaustiveness checking.
 */
export const VIEW_TYPE_ALIASES = {
  /** How a chip's need is met — `v_chip_satisfies.via`, ranked 1/2/3 downstream. */
  SatisfactionVia: "'self' | 'equivalent' | 'provides'",
  /** `v_system_chip_coverage.satisfied_via` adds the miss case. */
  SatisfactionOutcome: "'self' | 'equivalent' | 'provides' | 'unsatisfied'",
  /** `v_chip_evidence.evidence_rank`; 4 is the `COALESCE` miss in coverage views. */
  EvidenceRank: '1 | 2 | 3',
  CoverageEvidenceRank: '1 | 2 | 3 | 4',
  /** coverage.md §3.4's three-level confidence, on chips and on systems alike. */
  Confidence: "'high' | 'medium' | 'low'",
  /** Where a BOM line came from — `v_machine_bom.via`. */
  BomSource: "'machine' | 'system'",
  /** Where a system's chip came from — `v_system_chip_effective.via`. */
  SystemChipSource: "'curated' | 'mame'",
  /** `machine.driver_status`'s CHECK, surfaced through `v_machine`. */
  DriverStatus: "'good' | 'imperfect' | 'preliminary'",
  /** `chip_function.prospector_band`'s CHECK, surfaced through `v_chip_gap`. */
  ProspectorBand: "'hard' | 'medium' | 'soft'",
  /**
   * The closed warning registry (data-quality.md Appendix Q). Hand-listed because
   * the codes are SQL string literals inside `v_quality_warning`, so an empty
   * database yields none of them — but `view-types.spec.ts` re-parses the view's
   * own DDL and fails if this list and the DDL disagree.
   */
  QualityWarningCode: [
    "'MAPPED_INSTANCE_SHARE_LOW'",
    "'UNMAPPED_DEVICE_HIGH_IMPACT'",
    "'CHIP_MISSING_METADATA'",
    "'IMPL_UNVERIFIED_LICENSE'",
    "'IMPL_UNVERIFIED_ACCURACY'",
    "'IMPL_STALE_REVIEW'",
    "'IMPL_UNTARGETED'",
    "'IMPL_MACHINES_WITHOUT_SYSTEM'",
    "'SYSTEM_NO_CHIPS'",
    "'SYSTEM_UNMAPPED_SHARE_HIGH'",
    "'MACHINE_ZERO_MAPPED_CHIPS'",
    "'EQUIVALENCE_MUTUAL_PROVIDES'",
    "'CHIP_NAME_COLLISION'",
    "'SYSTEM_NAME_COLLISION'",
    "'CHIP_MANUFACTURER_FAMILY_MISMATCH'",
  ].join(' | '),
};

/**
 * `view name -> { column -> TypeScript type }`, in DDL column order.
 *
 * The generator fails if any view here is missing, unknown, or lists a different
 * column set or order than `schemas/schema.sql` produces.
 */
export const VIEW_COLUMN_TYPES = {
  // --- data-model.md Appendix B ------------------------------------------------
  v_machine_system: {
    machine_id: 'string',
    // CASE over two LEFT JOINs: a machine in no system and matching no
    // system_driver rule gets NULL, and 9 775 rows in, most of them do.
    system_id: 'string | null',
  },

  v_machine: {
    machine_id: 'string',
    // COALESCE(machine_correction.name, machine.name); machine.name is NOT NULL.
    name: 'string',
    system_id: 'string | null',
    // Parsed out of MAME's free-text year, which is routinely `19??`.
    year: 'number | null',
    manufacturer_id: 'string | null',
    mame_sourcefile: 'string',
    driver_status: 'DriverStatus | null',
    clone_count: 'number | null',
  },

  v_machine_bom: {
    machine_id: 'string',
    chip_id: 'string',
    // machine_chip.mame_tag or system_chip.role_id; both NOT NULL.
    role: 'string',
    quantity: 'number',
    clock_hz: 'number | null',
    via: 'BomSource',
  },

  v_chip_satisfies: {
    socket_chip_id: 'string',
    provider_chip_id: 'string',
    via: 'SatisfactionVia',
  },

  v_chip_implementation_count: {
    chip_id: 'string',
    kind_id: 'string',
    implementation_count: 'number',
  },

  v_system_chip_effective: {
    system_id: 'string',
    chip_id: 'string',
    via: 'SystemChipSource',
  },

  v_system_unmapped: {
    system_id: 'string',
    unmapped_device_count: 'number',
  },

  v_system_core: {
    kind_id: 'string',
    system_id: 'string',
    platform_id: 'string',
    implementation_id: 'string',
  },

  v_mame_device_worklist: {
    mame_device: 'string',
    machine_count: 'number',
    // SUM over a GROUP BY group, and quantity is NOT NULL, so never NULL.
    instance_count: 'number',
  },

  // --- coverage.md §3.4 ---------------------------------------------------------
  v_chip_satisfied: {
    kind_id: 'string',
    chip_id: 'string',
    via: 'SatisfactionVia',
    evidence_rank: 'EvidenceRank',
    provider_chip_id: 'string',
  },

  v_chip_evidence: {
    kind_id: 'string',
    chip_id: 'string',
    evidence_rank: 'EvidenceRank',
    best_via: 'SatisfactionVia',
    confidence: 'Confidence',
    // Correlated MIN() over the rows the outer GROUP BY was built from, so the
    // subquery always sees at least one row.
    provider_chip_id: 'string',
  },

  v_system_chip_coverage: {
    kind_id: 'string',
    system_id: 'string',
    chip_id: 'string',
    satisfied_via: 'SatisfactionOutcome',
    evidence_rank: 'CoverageEvidenceRank',
    // LEFT JOIN to v_chip_evidence: NULL exactly when satisfied_via is
    // 'unsatisfied' and evidence_rank is 4.
    provider_chip_id: 'string | null',
    chip_confidence: 'Confidence | null',
  },

  v_system_coverage_by_kind: {
    kind_id: 'string',
    system_id: 'string',
    chips_total: 'number',
    chips_direct: 'number',
    chips_equivalent: 'number',
    chips_provided: 'number',
    chips_satisfied: 'number',
    // REAL in [0, 1]; the CASE guards the zero-chip divide.
    satisfied_share: 'number',
    unmapped_device_count: 'number',
    confidence: 'Confidence',
  },

  v_prospector: {
    platform_id: 'string',
    system_id: 'string',
    chips_total: 'number',
    chips_direct: 'number',
    chips_equivalent: 'number',
    chips_provided: 'number',
    chips_satisfied: 'number',
    satisfied_share: 'number',
    unmapped_device_count: 'number',
    confidence: 'Confidence',
  },

  v_chip_gap: {
    kind_id: 'string',
    chip_id: 'string',
    display_name: 'string',
    function_id: 'string',
    prospector_band: 'ProspectorBand',
    system_count: 'number',
    machine_count: 'number',
  },

  // --- data-quality.md Appendix Q ------------------------------------------------
  v_quality_instance: {
    mapped_instances: 'number',
    unmapped_instances: 'number',
    total_instances: 'number',
    mapped_instance_share: 'number',
  },

  v_quality_device: {
    devices_mapped: 'number',
    devices_ignored: 'number',
    devices_unmapped: 'number',
  },

  v_machine_instance: {
    machine_id: 'string',
    mapped_instances: 'number',
    unmapped_instances: 'number',
  },

  v_system_instance: {
    system_id: 'string',
    mapped_instances: 'number',
    unmapped_instances: 'number',
    unmapped_share: 'number',
  },

  v_quality_completeness: {
    entity: 'string',
    column_name: 'string',
    rows_total: 'number',
    rows_present: 'number',
  },

  v_quality_warning: {
    code: 'QualityWarningCode',
    // The subject of the finding: a chip_id, an implementation_id, a machine_id, a
    // system_id, a MAME device key, or an equivalence edge rendered `a -> b`.
    // NULL on the one dataset-wide code.
    subject: 'string | null',
    // A count, a day span or a ROUND()ed share, depending on the code; NULL where
    // the finding has no magnitude.
    impact: 'number | null',
    detail: 'string',
  },
};

/**
 * Tables with no JSON Schema, typed here instead.
 *
 * `threshold` is written by the loader from `pipeline/config/quality-thresholds.json`
 * rather than from a curated row file, so it has no row-file schema to generate
 * from. It is still a real table in `schemas/schema.sql` and the generator asserts
 * that this map plus the JSON Schemas account for every table in the DDL.
 */
export const EXTRA_TABLE_TYPES = {
  threshold: {
    name: 'string',
    value: 'number',
  },
};
