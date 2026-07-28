/**
 * The diff: every part every witness asserted, classified, with a citation.
 *
 * ## The three classifications, and what each one is *for*
 *
 * - **`agreed`** — MAME and at least one independent witness name the same part. Not a
 *   finding; it is the denominator that makes the other two mean something. A system whose
 *   reference witnesses agree with MAME on nothing has a broken binding, not a broken BOM,
 *   and only the agreed count shows that.
 * - **`reference-only`** — an independent witness names a part MAME does not. This is the
 *   class of error a second witness exists to catch, and it splits by `mame_state`:
 *   - `absent` — MAME models nothing here at all. **This is the blind spot.** An absent
 *     part is not counted as unmapped, so it never reaches `v_mame_device_worklist` and
 *     never lowers a coverage number; the system simply scores as better covered than it
 *     is. Capcom's CPS-A/CPS-B are the worked example.
 *   - `unmapped` — MAME sees a device, nobody has mapped it. Already on the T3.2 worklist;
 *     a reference naming it is corroboration, and useful, but not news.
 * - **`mame-only`** — MAME names a part no reference witness does. Usually *not* an error:
 *   MAME enumerates every socket including EEPROMs, dial counters and bootleg
 *   substitutions, while a wiki infobox lists the four chips a reader cares about. This is
 *   why every `mame-only` finding carries `machine_count` and `machine_share`: a part on 40
 *   of 40 machines that nobody else mentions is worth a look, and a part on 1 of 40 is a
 *   conversion kit.
 *
 * ## What this never does
 *
 * **It never writes `data/`.** A disagreement is a prompt, not a correction — the resolution
 * is a human authoring a `machine_correction`, `machine_chip_correction` or `system_chip`
 * row with a citation, exactly as T3.1's device worklist works. An automated writer here
 * would launder four sources of varying reliability into curated fact, and standing rule 3
 * exists to stop precisely that.
 *
 * **It is never a build failure.** The report is written under `dist/` with
 * `severity: "advisory"`, and `pipeline reconcile` exits 0 whatever it finds. Two of the
 * four witnesses are wikis; a red build on a wiki edit would be an outage caused by someone
 * else's typo, and the first fix anyone reached for would be to stop running it.
 */
import { compareBytes } from '../db/rowfiles.js';
import {
  MAME_WITNESS,
  WITNESS_IDS,
  type MameState,
  type SystemWitnesses,
  type WitnessId,
  type WitnessPart,
} from './witness.js';

export const CLASSIFICATIONS = ['agreed', 'mame-only', 'reference-only'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

/** One part, one system, one verdict. */
export interface Finding {
  readonly system_id: string;
  readonly classification: Classification;
  /** `chip:<chip_id>` or `part:<NORMALISED>`, from `parts.ts`. */
  readonly key: string;
  /** The clearest designation any witness used for it. */
  readonly designation: string;
  readonly chip_id?: string;
  readonly mame_state: MameState;
  /** Every witness that asserted this part, in {@link WITNESS_IDS} order. */
  readonly witnesses: readonly WitnessId[];
  /** Where a curator reads the claim. A reference citation when there is one. */
  readonly source_url: string;
  readonly evidence: string;
  /** MAME only: how many of the system's machines carry it, and what share that is. */
  readonly machine_count?: number;
  readonly machine_share?: number;
}

export interface WitnessSummary {
  readonly witness: WitnessId;
  readonly systems: number;
  readonly parts: number;
}

/** `dist/reconciliation-report.json`. */
export interface ReconciliationReport {
  readonly generator: string;
  /** Always `advisory`. This report never fails a build; see the module comment. */
  readonly severity: 'advisory';
  readonly mame_version: string;
  readonly mame_release: string;
  readonly summary: {
    readonly systems_total: number;
    readonly systems_with_reference_witness: number;
    readonly agreed: number;
    readonly mame_only: number;
    /**
     * Parts a reference names and MAME models nowhere. Every `reference-only` finding is
     * of this kind by construction — if MAME had the part, even as an unmapped device, the
     * keys would meet and the finding would be `agreed` — which is precisely why this is
     * the number that matters: it counts what no coverage metric in the dataset can see.
     */
    readonly reference_only: number;
    /**
     * `agreed` findings whose MAME side is still a `machine_unmapped_device`. These are
     * T3.2 worklist entries that now have an independent citation attached, so they are the
     * cheapest curation work in the report: the research is already done.
     */
    readonly agreed_unmapped_in_mame: number;
  };
  readonly witnesses: readonly WitnessSummary[];
  readonly findings: readonly Finding[];
}

/** Four decimal places, matching `quality-report.json`'s `mapped_instance_share`. */
function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/**
 * Picks the citation a curator should be shown. Reference witnesses win over MAME — the
 * point of a finding is the independent claim, and "MAME's XML says so" is not a reason to
 * add a row — and among references the {@link WITNESS_IDS} order breaks the tie.
 */
function bestCitation(
  byWitness: ReadonlyMap<WitnessId, WitnessPart>,
): { readonly part: WitnessPart; readonly witness: WitnessId } | undefined {
  for (const witness of WITNESS_IDS) {
    if (witness === MAME_WITNESS) continue;
    const part = byWitness.get(witness);
    if (part !== undefined) return { part, witness };
  }
  const mame = byWitness.get(MAME_WITNESS);
  return mame === undefined ? undefined : { part: mame, witness: MAME_WITNESS };
}

/**
 * Classifies every part of every system.
 *
 * `machineCounts` is `system_id -> machines in that system`, used only to turn a
 * `machine_count` into a share. A system absent from it contributes no share, rather than a
 * division by zero dressed up as a number.
 */
export function classify(
  systems: readonly SystemWitnesses[],
  machineCounts: ReadonlyMap<string, number>,
): readonly Finding[] {
  const findings: Finding[] = [];

  for (const system of systems) {
    /** part key -> which witnesses asserted it, and with what. */
    const byKey = new Map<string, Map<WitnessId, WitnessPart>>();
    for (const record of system.witnesses) {
      for (const part of record.parts) {
        const bucket = byKey.get(part.key) ?? new Map<WitnessId, WitnessPart>();
        bucket.set(record.witness, part);
        byKey.set(part.key, bucket);
      }
    }

    const machines = machineCounts.get(system.system_id);
    for (const [key, byWitness] of byKey) {
      const mame = byWitness.get(MAME_WITNESS);
      const references = WITNESS_IDS.filter(
        (witness) => witness !== MAME_WITNESS && byWitness.has(witness),
      );
      const classification: Classification =
        mame !== undefined && references.length > 0
          ? 'agreed'
          : mame !== undefined
            ? 'mame-only'
            : 'reference-only';
      const citation = bestCitation(byWitness);
      if (citation === undefined) continue;

      const chipId = [...byWitness.values()].find((part) => part.chip_id !== undefined)?.chip_id;
      const share =
        mame?.machine_count !== undefined && machines !== undefined && machines > 0
          ? round4(mame.machine_count / machines)
          : undefined;

      findings.push({
        system_id: system.system_id,
        classification,
        key,
        designation: citation.part.designation,
        ...(chipId !== undefined ? { chip_id: chipId } : {}),
        mame_state: mame?.mame_state ?? 'absent',
        witnesses: WITNESS_IDS.filter((witness) => byWitness.has(witness)),
        source_url: citation.part.source_url,
        evidence: citation.part.evidence,
        ...(mame?.machine_count !== undefined ? { machine_count: mame.machine_count } : {}),
        ...(share !== undefined ? { machine_share: share } : {}),
      });
    }
  }

  // Reference-only first, then mame-only, then agreed: the file is read top-down by a
  // curator looking for work, and the work is at the top.
  const rank: Record<Classification, number> = {
    'reference-only': 0,
    'mame-only': 1,
    agreed: 2,
  };
  return findings.sort(
    (a, b) =>
      rank[a.classification] - rank[b.classification] ||
      compareBytes(a.system_id, b.system_id) ||
      compareBytes(a.key, b.key),
  );
}

export function buildReport(
  systems: readonly SystemWitnesses[],
  machineCounts: ReadonlyMap<string, number>,
  meta: { readonly mameVersion: string; readonly mameRelease: string; readonly generator: string },
): ReconciliationReport {
  const findings = classify(systems, machineCounts);
  const witnessSystems = new Map<WitnessId, number>();
  const witnessParts = new Map<WitnessId, number>();
  for (const system of systems) {
    for (const record of system.witnesses) {
      witnessSystems.set(record.witness, (witnessSystems.get(record.witness) ?? 0) + 1);
      witnessParts.set(
        record.witness,
        (witnessParts.get(record.witness) ?? 0) + record.parts.length,
      );
    }
  }

  const withReference = systems.filter((system) =>
    system.witnesses.some((record) => record.witness !== MAME_WITNESS),
  ).length;
  const count = (classification: Classification): number =>
    findings.filter((finding) => finding.classification === classification).length;

  return {
    generator: meta.generator,
    severity: 'advisory',
    mame_version: meta.mameVersion,
    mame_release: meta.mameRelease,
    summary: {
      systems_total: systems.length,
      systems_with_reference_witness: withReference,
      agreed: count('agreed'),
      mame_only: count('mame-only'),
      reference_only: count('reference-only'),
      agreed_unmapped_in_mame: findings.filter(
        (finding) => finding.classification === 'agreed' && finding.mame_state === 'unmapped',
      ).length,
    },
    witnesses: WITNESS_IDS.filter((witness) => (witnessSystems.get(witness) ?? 0) > 0).map(
      (witness) => ({
        witness,
        systems: witnessSystems.get(witness) ?? 0,
        parts: witnessParts.get(witness) ?? 0,
      }),
    ),
    findings,
  };
}

/** `dist/reconciliation-report.json`, two-space indented with one trailing newline. */
export function formatReportJson(report: ReconciliationReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

const TOP_FINDINGS = 25;

/** The human-readable summary `pipeline reconcile` prints. */
export function formatReportLog(report: ReconciliationReport): string {
  const lines: string[] = [];
  lines.push(
    `reconcile: ${report.summary.systems_total} systems, ` +
      `${report.summary.systems_with_reference_witness} with an independent witness ` +
      `(MAME ${report.mame_version})`,
  );
  for (const witness of report.witnesses) {
    lines.push(
      `reconcile:   ${witness.witness.padEnd(13)} ${String(witness.systems).padStart(3)} systems, ` +
        `${String(witness.parts).padStart(4)} parts`,
    );
  }
  lines.push(
    `reconcile: agreed ${report.summary.agreed} ` +
      `(${report.summary.agreed_unmapped_in_mame} of them still unmapped in MAME), ` +
      `mame-only ${report.summary.mame_only}, reference-only ${report.summary.reference_only}`,
  );

  const headline = report.findings.filter((finding) => finding.classification === 'reference-only');
  if (headline.length > 0) {
    lines.push('reconcile: parts a reference names and MAME does not model at all:');
    for (const finding of headline.slice(0, TOP_FINDINGS)) {
      lines.push(
        `reconcile:   ${finding.system_id.padEnd(26)} ${finding.designation.padEnd(16)} ` +
          `[${finding.witnesses.join(',')}] ${finding.source_url}`,
      );
    }
    if (headline.length > TOP_FINDINGS) {
      lines.push(`reconcile:   … and ${headline.length - TOP_FINDINGS} more; see the report`);
    }
  }
  lines.push('reconcile: advisory only — this report never fails a build and never writes data/');
  return `${lines.join('\n')}\n`;
}
