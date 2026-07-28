/**
 * TASKS T3.8 — the classification, and the join that decides which board a part is on.
 *
 * Two claims, and the second is the one that would silently corrupt every finding if it
 * were wrong:
 *
 * 1. `classify` sorts every part into `agreed` / `mame-only` / `reference-only` and carries
 *    a citation and a MAME state on each.
 * 2. `resolveMachineSystems` reproduces `v_machine_system`'s precedence — a `machine_system`
 *    row wins, else the `system_driver` rule for the machine's source file, else nothing.
 *    That view lives in `schemas/schema.sql`; this is the restatement of it that runs
 *    without a database, so it is proved directly rather than assumed.
 */
import { describe, expect, it } from 'vitest';

import { resolveMachineSystems } from '../src/reconcile/dataset.js';
import { buildReport, classify, formatReportLog } from '../src/reconcile/report.js';
import {
  collapseParts,
  type SystemWitnesses,
  type WitnessId,
  type WitnessPart,
  type WitnessRecord,
} from '../src/reconcile/witness.js';

/**
 * `collapseParts` returns `undefined` for an empty list, which cannot happen here — every
 * fixture below asserts at least one part — so this narrows it without a `!`.
 */
function record(witness: WitnessId, parts: readonly WitnessPart[]): WitnessRecord {
  const collapsed = collapseParts(witness, parts);
  if (collapsed === undefined) throw new Error(`fixture for ${witness} asserted nothing`);
  return collapsed;
}

function part(
  overrides: Partial<WitnessPart> & Pick<WitnessPart, 'key' | 'designation'>,
): WitnessPart {
  return {
    source_url: 'https://example.invalid/claim',
    evidence: 'evidence',
    ...overrides,
  };
}

/** CPS-1 in miniature: MAME has the 68000 and an EEPROM; the driver names the customs. */
const systems: readonly SystemWitnesses[] = [
  {
    system_id: 'capcom-cps1',
    witnesses: [
      record('mame-listxml', [
        part({
          key: 'chip:m68000',
          designation: 'm68000',
          chip_id: 'm68000',
          mame_state: 'mapped',
          machine_count: 40,
          source_url: 'https://example.invalid/listxml',
        }),
        part({
          key: 'chip:93c46',
          designation: '93c46',
          chip_id: '93c46',
          mame_state: 'mapped',
          machine_count: 4,
          source_url: 'https://example.invalid/listxml',
        }),
        part({
          key: 'part:UPD4701A',
          designation: 'upd4701a',
          mame_state: 'unmapped',
          machine_count: 2,
          source_url: 'https://example.invalid/listxml',
        }),
      ]),
      record('mame-source', [
        part({ key: 'chip:m68000', designation: 'MC68000', chip_id: 'm68000' }),
        part({ key: 'part:CPSB01', designation: 'CPS-B-01' }),
      ]),
      record('jtcores', [part({ key: 'part:UPD4701A', designation: 'uPD4701A' })]),
    ],
  },
];

const findings = classify(systems, new Map([['capcom-cps1', 40]]));
const find = (key: string): (typeof findings)[number] | undefined =>
  findings.find((finding) => finding.key === key);

describe('classify', () => {
  it('calls a part both sides name agreed, and lists every witness', () => {
    expect(find('chip:m68000')?.classification).toBe('agreed');
    expect(find('chip:m68000')?.witnesses).toEqual(['mame-listxml', 'mame-source']);
  });

  it('calls a part only MAME names mame-only, with the share that makes it triageable', () => {
    expect(find('chip:93c46')?.classification).toBe('mame-only');
    expect(find('chip:93c46')?.machine_count).toBe(4);
    expect(find('chip:93c46')?.machine_share).toBe(0.1);
  });

  it('calls a part only a reference names reference-only, and marks MAME absent', () => {
    // This is the blind spot: absent from machine_chip *and* machine_unmapped_device, so
    // no coverage metric in the dataset can see that it is missing.
    expect(find('part:CPSB01')?.classification).toBe('reference-only');
    expect(find('part:CPSB01')?.mame_state).toBe('absent');
  });

  it('keeps "MAME sees it but nobody mapped it" distinct from "MAME does not have it"', () => {
    expect(find('part:UPD4701A')?.classification).toBe('agreed');
    expect(find('part:UPD4701A')?.mame_state).toBe('unmapped');
  });

  it('cites the reference, not MAME, whenever there is a reference to cite', () => {
    expect(find('chip:m68000')?.source_url).toBe('https://example.invalid/claim');
    expect(find('chip:93c46')?.source_url).toBe('https://example.invalid/listxml');
  });

  it('puts the work at the top: reference-only, then mame-only, then agreed', () => {
    expect(findings.map((finding) => finding.classification)).toEqual([
      'reference-only',
      'mame-only',
      'agreed',
      'agreed',
    ]);
  });

  it('is deterministic — the same input twice is the same array', () => {
    expect(classify(systems, new Map([['capcom-cps1', 40]]))).toEqual(findings);
  });
});

describe('buildReport', () => {
  const report = buildReport(systems, new Map([['capcom-cps1', 40]]), {
    mameVersion: '0.288',
    mameRelease: 'mame0288',
    generator: 'pipeline reconcile',
  });

  it('is advisory, always', () => {
    expect(report.severity).toBe('advisory');
  });

  it('counts the systems that actually carry an independent witness', () => {
    expect(report.summary.systems_with_reference_witness).toBe(1);
    expect(report.summary.reference_only).toBe(1);
    expect(report.summary.agreed_unmapped_in_mame).toBe(1);
  });

  it('summarises each witness by systems and parts', () => {
    expect(report.witnesses).toEqual([
      { witness: 'mame-listxml', systems: 1, parts: 3 },
      { witness: 'mame-source', systems: 1, parts: 2 },
      { witness: 'jtcores', systems: 1, parts: 1 },
    ]);
  });

  it('prints the parts MAME models nowhere, and says it never fails a build', () => {
    const log = formatReportLog(report);
    expect(log).toContain('CPS-B-01');
    expect(log).toContain('never fails a build and never writes data/');
  });
});

describe('resolveMachineSystems — v_machine_system precedence, without a database', () => {
  const machines = [
    { machine_id: 'sf2ce', mame_sourcefile: 'capcom/cps1.cpp' },
    { machine_id: 'forgottn', mame_sourcefile: 'capcom/cps1.cpp' },
    { machine_id: 'orphan', mame_sourcefile: 'misc/nothing.cpp' },
  ];
  const drivers = [{ mame_sourcefile: 'capcom/cps1.cpp', system_id: 'capcom-cps1' }];

  it('applies the system_driver rule by default', () => {
    const resolved = resolveMachineSystems(machines, drivers, []);
    expect(resolved.get('forgottn')).toBe('capcom-cps1');
  });

  it('lets a machine_system row win over it', () => {
    const resolved = resolveMachineSystems(machines, drivers, [
      { machine_id: 'sf2ce', system_id: 'capcom-cps1-5' },
    ]);
    expect(resolved.get('sf2ce')).toBe('capcom-cps1-5');
    expect(resolved.get('forgottn')).toBe('capcom-cps1');
  });

  it('leaves a machine no rule reaches with no system at all', () => {
    expect(resolveMachineSystems(machines, drivers, []).has('orphan')).toBe(false);
  });

  it('ignores a machine_system row for a machine the extract does not have', () => {
    const resolved = resolveMachineSystems(machines, drivers, [
      { machine_id: 'notamachine', system_id: 'capcom-cps1' },
    ]);
    expect(resolved.has('notamachine')).toBe(false);
  });
});
