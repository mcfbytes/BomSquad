/* GENERATED FILE — DO NOT EDIT.
 *
 * Written by site/tools/generate-db-types.mjs from schemas/schema.sql (column names and order) + site/tools/view-column-types.mjs (types).
 * Regenerate with `npm run codegen --workspace @bomsquad/site`;
 * schema-types.spec.ts fails the suite if this file and its source disagree.
 */

/*
 * Views are the stable query surface (schemas/README.md), but SQLite records no
 * usable type metadata for them, so the column *types* below are declared in
 * site/tools/view-column-types.mjs and the column *names and order* come from
 * the DDL. The generator refuses to run if the two disagree.
 */

export type SatisfactionVia = 'self' | 'equivalent' | 'provides';
export type SatisfactionOutcome = 'self' | 'equivalent' | 'provides' | 'unsatisfied';
export type EvidenceRank = 1 | 2 | 3;
export type CoverageEvidenceRank = 1 | 2 | 3 | 4;
export type Confidence = 'high' | 'medium' | 'low';
export type BomSource = 'machine' | 'system';
export type SystemChipSource = 'curated' | 'mame';
export type DriverStatus = 'good' | 'imperfect' | 'preliminary';
export type ProspectorBand = 'hard' | 'medium' | 'soft';
export type QualityWarningCode =
  | 'MAPPED_INSTANCE_SHARE_LOW'
  | 'UNMAPPED_DEVICE_HIGH_IMPACT'
  | 'CHIP_MISSING_METADATA'
  | 'IMPL_UNVERIFIED_LICENSE'
  | 'IMPL_UNVERIFIED_ACCURACY'
  | 'IMPL_STALE_REVIEW'
  | 'IMPL_UNTARGETED'
  | 'IMPL_MACHINES_WITHOUT_SYSTEM'
  | 'SYSTEM_NO_CHIPS'
  | 'SYSTEM_UNMAPPED_SHARE_HIGH'
  | 'MACHINE_ZERO_MAPPED_CHIPS'
  | 'EQUIVALENCE_MUTUAL_PROVIDES'
  | 'CHIP_NAME_COLLISION'
  | 'SYSTEM_NAME_COLLISION'
  | 'CHIP_MANUFACTURER_FAMILY_MISMATCH';

/** One row of the `v_chip_evidence` view. */
export interface VChipEvidenceRow {
  readonly kind_id: string;
  readonly chip_id: string;
  readonly evidence_rank: EvidenceRank;
  readonly best_via: SatisfactionVia;
  readonly confidence: Confidence;
  readonly provider_chip_id: string;
}

/** One row of the `v_chip_gap` view. */
export interface VChipGapRow {
  readonly kind_id: string;
  readonly chip_id: string;
  readonly display_name: string;
  readonly function_id: string;
  readonly prospector_band: ProspectorBand;
  readonly system_count: number;
  readonly machine_count: number;
}

/** One row of the `v_chip_implementation_count` view. */
export interface VChipImplementationCountRow {
  readonly chip_id: string;
  readonly kind_id: string;
  readonly implementation_count: number;
}

/** One row of the `v_chip_satisfied` view. */
export interface VChipSatisfiedRow {
  readonly kind_id: string;
  readonly chip_id: string;
  readonly via: SatisfactionVia;
  readonly evidence_rank: EvidenceRank;
  readonly provider_chip_id: string;
}

/** One row of the `v_chip_satisfies` view. */
export interface VChipSatisfiesRow {
  readonly socket_chip_id: string;
  readonly provider_chip_id: string;
  readonly via: SatisfactionVia;
}

/** One row of the `v_machine` view. */
export interface VMachineRow {
  readonly machine_id: string;
  readonly name: string;
  readonly system_id: string | null;
  readonly year: number | null;
  readonly manufacturer_id: string | null;
  readonly mame_sourcefile: string;
  readonly driver_status: DriverStatus | null;
  readonly clone_count: number | null;
}

/** One row of the `v_machine_bom` view. */
export interface VMachineBomRow {
  readonly machine_id: string;
  readonly chip_id: string;
  readonly role: string;
  readonly quantity: number;
  readonly clock_hz: number | null;
  readonly via: BomSource;
}

/** One row of the `v_machine_instance` view. */
export interface VMachineInstanceRow {
  readonly machine_id: string;
  readonly mapped_instances: number;
  readonly unmapped_instances: number;
}

/** One row of the `v_machine_system` view. */
export interface VMachineSystemRow {
  readonly machine_id: string;
  readonly system_id: string | null;
}

/** One row of the `v_mame_device_worklist` view. */
export interface VMameDeviceWorklistRow {
  readonly mame_device: string;
  readonly machine_count: number;
  readonly instance_count: number;
}

/** One row of the `v_prospector` view. */
export interface VProspectorRow {
  readonly platform_id: string;
  readonly system_id: string;
  readonly chips_total: number;
  readonly chips_direct: number;
  readonly chips_equivalent: number;
  readonly chips_provided: number;
  readonly chips_satisfied: number;
  readonly satisfied_share: number;
  readonly unmapped_device_count: number;
  readonly confidence: Confidence;
}

/** One row of the `v_quality_completeness` view. */
export interface VQualityCompletenessRow {
  readonly entity: string;
  readonly column_name: string;
  readonly rows_total: number;
  readonly rows_present: number;
}

/** One row of the `v_quality_device` view. */
export interface VQualityDeviceRow {
  readonly devices_mapped: number;
  readonly devices_ignored: number;
  readonly devices_unmapped: number;
}

/** One row of the `v_quality_instance` view. */
export interface VQualityInstanceRow {
  readonly mapped_instances: number;
  readonly unmapped_instances: number;
  readonly total_instances: number;
  readonly mapped_instance_share: number;
}

/** One row of the `v_quality_warning` view. */
export interface VQualityWarningRow {
  readonly code: QualityWarningCode;
  readonly subject: string | null;
  readonly impact: number | null;
  readonly detail: string;
}

/** One row of the `v_system_chip_coverage` view. */
export interface VSystemChipCoverageRow {
  readonly kind_id: string;
  readonly system_id: string;
  readonly chip_id: string;
  readonly satisfied_via: SatisfactionOutcome;
  readonly evidence_rank: CoverageEvidenceRank;
  readonly provider_chip_id: string | null;
  readonly chip_confidence: Confidence | null;
}

/** One row of the `v_system_chip_effective` view. */
export interface VSystemChipEffectiveRow {
  readonly system_id: string;
  readonly chip_id: string;
  readonly via: SystemChipSource;
}

/** One row of the `v_system_core` view. */
export interface VSystemCoreRow {
  readonly kind_id: string;
  readonly system_id: string;
  readonly platform_id: string;
  readonly implementation_id: string;
}

/** One row of the `v_system_coverage_by_kind` view. */
export interface VSystemCoverageByKindRow {
  readonly kind_id: string;
  readonly system_id: string;
  readonly chips_total: number;
  readonly chips_direct: number;
  readonly chips_equivalent: number;
  readonly chips_provided: number;
  readonly chips_satisfied: number;
  readonly satisfied_share: number;
  readonly unmapped_device_count: number;
  readonly confidence: Confidence;
}

/** One row of the `v_system_instance` view. */
export interface VSystemInstanceRow {
  readonly system_id: string;
  readonly mapped_instances: number;
  readonly unmapped_instances: number;
  readonly unmapped_share: number;
}

/** One row of the `v_system_unmapped` view. */
export interface VSystemUnmappedRow {
  readonly system_id: string;
  readonly unmapped_device_count: number;
}

/** Every view in `schemas/schema.sql`, keyed by name. */
export interface ViewRowTypes {
  readonly v_chip_evidence: VChipEvidenceRow;
  readonly v_chip_gap: VChipGapRow;
  readonly v_chip_implementation_count: VChipImplementationCountRow;
  readonly v_chip_satisfied: VChipSatisfiedRow;
  readonly v_chip_satisfies: VChipSatisfiesRow;
  readonly v_machine: VMachineRow;
  readonly v_machine_bom: VMachineBomRow;
  readonly v_machine_instance: VMachineInstanceRow;
  readonly v_machine_system: VMachineSystemRow;
  readonly v_mame_device_worklist: VMameDeviceWorklistRow;
  readonly v_prospector: VProspectorRow;
  readonly v_quality_completeness: VQualityCompletenessRow;
  readonly v_quality_device: VQualityDeviceRow;
  readonly v_quality_instance: VQualityInstanceRow;
  readonly v_quality_warning: VQualityWarningRow;
  readonly v_system_chip_coverage: VSystemChipCoverageRow;
  readonly v_system_chip_effective: VSystemChipEffectiveRow;
  readonly v_system_core: VSystemCoreRow;
  readonly v_system_coverage_by_kind: VSystemCoverageByKindRow;
  readonly v_system_instance: VSystemInstanceRow;
  readonly v_system_unmapped: VSystemUnmappedRow;
}

export type ViewName = keyof ViewRowTypes;

/** Sorted, so the list is stable across regenerations. */
export const VIEW_NAMES: readonly ViewName[] = [
  'v_chip_evidence',
  'v_chip_gap',
  'v_chip_implementation_count',
  'v_chip_satisfied',
  'v_chip_satisfies',
  'v_machine',
  'v_machine_bom',
  'v_machine_instance',
  'v_machine_system',
  'v_mame_device_worklist',
  'v_prospector',
  'v_quality_completeness',
  'v_quality_device',
  'v_quality_instance',
  'v_quality_warning',
  'v_system_chip_coverage',
  'v_system_chip_effective',
  'v_system_core',
  'v_system_coverage_by_kind',
  'v_system_instance',
  'v_system_unmapped',
];
