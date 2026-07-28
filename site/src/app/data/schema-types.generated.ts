/* GENERATED FILE — DO NOT EDIT.
 *
 * Written by site/tools/generate-db-types.mjs from schemas/*.schema.json, cross-checked against schemas/schema.sql.
 * Regenerate with `npm run codegen --workspace @bomsquad/site`;
 * schema-types.spec.ts fails the suite if this file and its source disagree.
 */

/*
 * A row as the *database* returns it, which is not quite a row as a curated row
 * file writes it: data-model.md §4.3 omits a NULL column rather than writing
 * `null`, so a JSON-Schema-optional property is `T | null` here. Nullability is
 * therefore read off the DDL, never off `required` — `machine_chip.quantity` is
 * omissible in a row file (it defaults to 1) and still NOT NULL in the table.
 */

/** One row of the `accuracy_level` table. Keys and order follow schemas/schema.sql. */
export interface AccuracyLevelRow {
  readonly accuracy_id: string;
  readonly label: string;
  readonly description: string;
}

/** One row of the `chip` table. Keys and order follow schemas/schema.sql. */
export interface ChipRow {
  readonly chip_id: string;
  readonly display_name: string;
  readonly function_id: string;
  readonly manufacturer_id: string | null;
  readonly family_id: string | null;
  readonly model: string | null;
  readonly description: string | null;
  readonly typical_clock_hz: number | null;
  readonly package: string | null;
  readonly year_introduced: number | null;
  readonly notes: string | null;
}

/** One row of the `chip_datasheet` table. Keys and order follow schemas/schema.sql. */
export interface ChipDatasheetRow {
  readonly chip_id: string;
  readonly url: string;
  readonly title: string | null;
}

/** One row of the `chip_equivalence` table. Keys and order follow schemas/schema.sql. */
export interface ChipEquivalenceRow {
  readonly from_chip_id: string;
  readonly to_chip_id: string;
  readonly kind: 'equivalent' | 'provides';
  readonly note: string;
}

/** One row of the `chip_family` table. Keys and order follow schemas/schema.sql. */
export interface ChipFamilyRow {
  readonly family_id: string;
  readonly name: string;
  readonly manufacturer_id: string | null;
  readonly description: string | null;
}

/** One row of the `chip_function` table. Keys and order follow schemas/schema.sql. */
export interface ChipFunctionRow {
  readonly function_id: string;
  readonly label: string;
  readonly description: string;
  readonly prospector_band: 'hard' | 'medium' | 'soft';
}

/** One row of the `chip_name` table. Keys and order follow schemas/schema.sql. */
export interface ChipNameRow {
  readonly chip_id: string;
  readonly name: string;
  readonly kind: 'alias' | 'retired_id';
}

/** One row of the `chip_role` table. Keys and order follow schemas/schema.sql. */
export interface ChipRoleRow {
  readonly role_id: string;
  readonly label: string;
  readonly description: string | null;
}

/** One row of the `dataset_meta` table. Keys and order follow schemas/schema.sql. */
export interface DatasetMetaRow {
  readonly key: string;
  readonly value: string;
}

/** One row of the `fpga_platform` table. Keys and order follow schemas/schema.sql. */
export interface FpgaPlatformRow {
  readonly platform_id: string;
  readonly label: string;
  readonly notes: string | null;
}

/** One row of the `hdl_language` table. Keys and order follow schemas/schema.sql. */
export interface HdlLanguageRow {
  readonly language_id: string;
  readonly label: string;
}

/** One row of the `implementation` table. Keys and order follow schemas/schema.sql. */
export interface ImplementationRow {
  readonly implementation_id: string;
  readonly name: string;
  readonly kind_id: string;
  readonly project_id: string | null;
  readonly repo_url: string | null;
  readonly hdl_language_id: string | null;
  readonly license_id: string | null;
  readonly accuracy_id: string | null;
  readonly verified_against_hardware: (0 | 1) | null;
  readonly resource_notes: string | null;
  readonly last_reviewed: string | null;
  readonly notes: string | null;
}

/** One row of the `implementation_chip` table. Keys and order follow schemas/schema.sql. */
export interface ImplementationChipRow {
  readonly implementation_id: string;
  readonly chip_id: string;
}

/** One row of the `implementation_dependency` table. Keys and order follow schemas/schema.sql. */
export interface ImplementationDependencyRow {
  readonly consumer_id: string;
  readonly provider_id: string;
  readonly note: string | null;
}

/** One row of the `implementation_kind` table. Keys and order follow schemas/schema.sql. */
export interface ImplementationKindRow {
  readonly kind_id: string;
  readonly label: string;
  readonly description: string;
}

/** One row of the `implementation_machine` table. Keys and order follow schemas/schema.sql. */
export interface ImplementationMachineRow {
  readonly implementation_id: string;
  readonly machine_id: string;
}

/** One row of the `implementation_path` table. Keys and order follow schemas/schema.sql. */
export interface ImplementationPathRow {
  readonly implementation_id: string;
  readonly path: string;
  readonly is_top: 0 | 1;
}

/** One row of the `implementation_platform` table. Keys and order follow schemas/schema.sql. */
export interface ImplementationPlatformRow {
  readonly implementation_id: string;
  readonly platform_id: string;
}

/** One row of the `implementation_system` table. Keys and order follow schemas/schema.sql. */
export interface ImplementationSystemRow {
  readonly implementation_id: string;
  readonly system_id: string;
}

/** One row of the `license` table. Keys and order follow schemas/schema.sql. */
export interface LicenseRow {
  readonly license_id: string;
  readonly name: string;
  readonly url: string | null;
  readonly is_osi_approved: 0 | 1;
}

/** One row of the `machine` table. Keys and order follow schemas/schema.sql. */
export interface MachineRow {
  readonly machine_id: string;
  readonly name: string;
  readonly mame_sourcefile: string;
  readonly mame_year: string | null;
  readonly mame_manufacturer: string | null;
  readonly clone_count: number | null;
  readonly driver_status: ('good' | 'imperfect' | 'preliminary') | null;
  readonly is_bios: 0 | 1;
  readonly is_device: 0 | 1;
  readonly is_mechanical: 0 | 1;
}

/** One row of the `machine_chip` table. Keys and order follow schemas/schema.sql. */
export interface MachineChipRow {
  readonly machine_id: string;
  readonly mame_tag: string;
  readonly chip_id: string;
  readonly clock_hz: number | null;
  readonly quantity: number;
}

/** One row of the `machine_chip_correction` table. Keys and order follow schemas/schema.sql. */
export interface MachineChipCorrectionRow {
  readonly machine_id: string;
  readonly mame_tag: string;
  readonly chip_id: string;
  readonly op: 'add' | 'remove' | 'set';
  readonly clock_hz: number | null;
  readonly quantity: number | null;
  readonly reason: string;
  readonly source_url: string | null;
}

/** One row of the `machine_correction` table. Keys and order follow schemas/schema.sql. */
export interface MachineCorrectionRow {
  readonly machine_id: string;
  readonly name: string | null;
  readonly year: number | null;
  readonly manufacturer_id: string | null;
  readonly reason: string;
  readonly source_url: string | null;
}

/** One row of the `machine_system` table. Keys and order follow schemas/schema.sql. */
export interface MachineSystemRow {
  readonly machine_id: string;
  readonly system_id: string | null;
  readonly reason: string | null;
}

/** One row of the `machine_unmapped_device` table. Keys and order follow schemas/schema.sql. */
export interface MachineUnmappedDeviceRow {
  readonly machine_id: string;
  readonly mame_device: string;
  readonly quantity: number;
}

/** One row of the `mame_device` table. Keys and order follow schemas/schema.sql. */
export interface MameDeviceRow {
  readonly mame_device: string;
  readonly chip_id: string | null;
  readonly ignore_reason: string | null;
  readonly note: string | null;
}

/** One row of the `manufacturer` table. Keys and order follow schemas/schema.sql. */
export interface ManufacturerRow {
  readonly manufacturer_id: string;
  readonly name: string;
  readonly country: string | null;
  readonly notes: string | null;
}

/** One row of the `manufacturer_alias` table. Keys and order follow schemas/schema.sql. */
export interface ManufacturerAliasRow {
  readonly alias: string;
  readonly manufacturer_id: string;
}

/** One row of the `project` table. Keys and order follow schemas/schema.sql. */
export interface ProjectRow {
  readonly project_id: string;
  readonly name: string;
  readonly url: string | null;
  readonly author: string | null;
  readonly notes: string | null;
}

/** One row of the `system` table. Keys and order follow schemas/schema.sql. */
export interface SystemRow {
  readonly system_id: string;
  readonly name: string;
  readonly kind_id: string;
  readonly manufacturer_id: string | null;
  readonly year_introduced: number | null;
  readonly description: string | null;
  readonly notes: string | null;
}

/** One row of the `system_chip` table. Keys and order follow schemas/schema.sql. */
export interface SystemChipRow {
  readonly system_id: string;
  readonly role_id: string;
  readonly chip_id: string;
  readonly quantity: number;
  readonly clock_hz: number | null;
  readonly note: string | null;
}

/** One row of the `system_driver` table. Keys and order follow schemas/schema.sql. */
export interface SystemDriverRow {
  readonly mame_sourcefile: string;
  readonly system_id: string;
}

/** One row of the `system_kind` table. Keys and order follow schemas/schema.sql. */
export interface SystemKindRow {
  readonly kind_id: string;
  readonly label: string;
}

/** One row of the `system_name` table. Keys and order follow schemas/schema.sql. */
export interface SystemNameRow {
  readonly system_id: string;
  readonly name: string;
  readonly kind: 'alias' | 'retired_id';
}

/** One row of the `threshold` table. */
export interface ThresholdRow {
  readonly name: string;
  readonly value: number;
}

/** Every table in `schemas/schema.sql`, keyed by name. */
export interface TableRowTypes {
  readonly accuracy_level: AccuracyLevelRow;
  readonly chip: ChipRow;
  readonly chip_datasheet: ChipDatasheetRow;
  readonly chip_equivalence: ChipEquivalenceRow;
  readonly chip_family: ChipFamilyRow;
  readonly chip_function: ChipFunctionRow;
  readonly chip_name: ChipNameRow;
  readonly chip_role: ChipRoleRow;
  readonly dataset_meta: DatasetMetaRow;
  readonly fpga_platform: FpgaPlatformRow;
  readonly hdl_language: HdlLanguageRow;
  readonly implementation: ImplementationRow;
  readonly implementation_chip: ImplementationChipRow;
  readonly implementation_dependency: ImplementationDependencyRow;
  readonly implementation_kind: ImplementationKindRow;
  readonly implementation_machine: ImplementationMachineRow;
  readonly implementation_path: ImplementationPathRow;
  readonly implementation_platform: ImplementationPlatformRow;
  readonly implementation_system: ImplementationSystemRow;
  readonly license: LicenseRow;
  readonly machine: MachineRow;
  readonly machine_chip: MachineChipRow;
  readonly machine_chip_correction: MachineChipCorrectionRow;
  readonly machine_correction: MachineCorrectionRow;
  readonly machine_system: MachineSystemRow;
  readonly machine_unmapped_device: MachineUnmappedDeviceRow;
  readonly mame_device: MameDeviceRow;
  readonly manufacturer: ManufacturerRow;
  readonly manufacturer_alias: ManufacturerAliasRow;
  readonly project: ProjectRow;
  readonly system: SystemRow;
  readonly system_chip: SystemChipRow;
  readonly system_driver: SystemDriverRow;
  readonly system_kind: SystemKindRow;
  readonly system_name: SystemNameRow;
  readonly threshold: ThresholdRow;
}

export type TableName = keyof TableRowTypes;

/** Sorted, so the list is stable across regenerations. */
export const TABLE_NAMES: readonly TableName[] = [
  'accuracy_level',
  'chip',
  'chip_datasheet',
  'chip_equivalence',
  'chip_family',
  'chip_function',
  'chip_name',
  'chip_role',
  'dataset_meta',
  'fpga_platform',
  'hdl_language',
  'implementation',
  'implementation_chip',
  'implementation_dependency',
  'implementation_kind',
  'implementation_machine',
  'implementation_path',
  'implementation_platform',
  'implementation_system',
  'license',
  'machine',
  'machine_chip',
  'machine_chip_correction',
  'machine_correction',
  'machine_system',
  'machine_unmapped_device',
  'mame_device',
  'manufacturer',
  'manufacturer_alias',
  'project',
  'system',
  'system_chip',
  'system_driver',
  'system_kind',
  'system_name',
  'threshold',
];
