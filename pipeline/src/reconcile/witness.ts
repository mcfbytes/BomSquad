/**
 * What a witness is, and the shape every one of them returns.
 *
 * A *witness* is one source's answer to a single question: **which parts are on this
 * board?** Nothing here knows how to answer it — the five modules beside this one do — and
 * nothing here compares two answers, which is `report.ts`'s job. This file exists so that
 * adding a sixth source is one new module and one entry in {@link WITNESS_IDS}, and so that
 * the record written to `extract/reconciliation.raw.json` has exactly one definition.
 *
 * Every part a witness asserts carries a **`source_url` a human can open** and an
 * **`evidence` line** — the driver comment, the infobox row, the module instantiation. That
 * is not decoration: TASKS T3.8 resolves a disagreement by a curator authoring a row with a
 * citation, so a finding without a citation is a finding nobody can act on, and standing
 * rule 3 would refuse the row anyway.
 */
import { compareBytes } from '../db/rowfiles.js';

/**
 * The witnesses, in report order: MAME's machine-readable half first, then every
 * independent one. Order matters only for presentation; all comparisons are set-based.
 */
export const WITNESS_IDS = [
  'mame-listxml',
  'mame-source',
  'wikidata',
  'wikipedia',
  'jtcores',
] as const;
export type WitnessId = (typeof WITNESS_IDS)[number];

/** The MAME `-listxml` witness. Everything else is an independent second opinion. */
export const MAME_WITNESS: WitnessId = 'mame-listxml';

/**
 * How MAME models a part, which is a different question from whether MAME *has* it.
 *
 * - `mapped` — a `machine_chip` row: MAME names a device and a curator has mapped it.
 * - `unmapped` — a `machine_unmapped_device` row: MAME names a device, nobody has mapped
 *   it yet, and it is already on the T3.2 worklist.
 * - `absent` — MAME names nothing at all. This is the state that matters, because it is
 *   invisible to every coverage metric the dataset has: an absent part is not counted as
 *   unmapped, so a system missing one scores as *better* covered than it is.
 */
export const MAME_STATES = ['mapped', 'unmapped', 'absent'] as const;
export type MameState = (typeof MAME_STATES)[number];

/** One part one witness asserts, with the citation that lets a curator check it. */
export interface WitnessPart {
  /** Comparison key from `parts.ts`: `chip:<chip_id>` or `part:<NORMALISED>`. */
  readonly key: string;
  /** The designation exactly as the witness wrote it. */
  readonly designation: string;
  /** Set when the designation resolves to a curated `chip` row. */
  readonly chip_id?: string;
  /** Only the MAME witness distinguishes these; see {@link MameState}. */
  readonly mame_state?: MameState;
  /** A URL a human can open and read the claim on. */
  readonly source_url: string;
  /** The line, field or instantiation the claim was read from. */
  readonly evidence: string;
  /** For the MAME witness: how many of the system's machines carry this part. */
  readonly machine_count?: number;
}

/** One witness's whole answer for one system. */
export interface WitnessRecord {
  readonly witness: WitnessId;
  /** Bytewise sorted by `key`. */
  readonly parts: readonly WitnessPart[];
}

/** Every witness's answer for one system, as written to `reconciliation.raw.json`. */
export interface SystemWitnesses {
  readonly system_id: string;
  /** In {@link WITNESS_IDS} order, and only witnesses that asserted something. */
  readonly witnesses: readonly WitnessRecord[];
}

/**
 * Collapses the parts one witness produced for one system into a record.
 *
 * Two witnesses' worth of the same part — the same driver naming `CPS-B-01` beside forty
 * different `ROM_START`s — is one assertion, and the citation kept is the bytewise-first
 * one, not "whichever the file system yielded first". That is the whole of what makes the
 * emitted file reproducible from a warm cache.
 */
export function collapseParts(
  witness: WitnessId,
  parts: readonly WitnessPart[],
): WitnessRecord | undefined {
  const best = new Map<string, WitnessPart>();
  for (const part of parts) {
    const existing = best.get(part.key);
    if (existing === undefined || compareWitnessParts(part, existing) < 0) {
      best.set(part.key, part);
    }
  }
  if (best.size === 0) return undefined;
  return {
    witness,
    parts: [...best.values()].sort((a, b) => compareWitnessParts(a, b)),
  };
}

/** Total order over parts: key, then citation, then evidence. No field is left to chance. */
export function compareWitnessParts(a: WitnessPart, b: WitnessPart): number {
  return (
    compareBytes(a.key, b.key) ||
    compareBytes(a.source_url, b.source_url) ||
    compareBytes(a.designation, b.designation) ||
    compareBytes(a.evidence, b.evidence)
  );
}
