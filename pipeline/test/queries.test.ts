/**
 * The canonical queries Q1–Q5 of docs/data-model.md §6 and the worked examples of
 * docs/coverage.md §6, asserted against the exact values those documents publish.
 *
 * Both fixtures are loaded through `src/db/load.ts`, so every assertion below also
 * exercises the loader's FK-safe ordering, primary-key sort and single transaction.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';

import { createSchemaDatabase, checkIntegrity } from '../src/db/schema.js';
import { loadRowFiles } from '../src/db/load.js';
import { canonicalQueryFixture, coverageFixture } from './fixtures.js';

const FPGA = 'fpga_hdl';

function rows(db: DatabaseSync, sql: string, params: Record<string, string> = {}): unknown[] {
  const statement = db.prepare(sql);
  return Object.keys(params).length === 0 ? statement.all() : statement.all(params);
}

describe('data-model.md §6 — the canonical queries', () => {
  let db: DatabaseSync;

  beforeAll(() => {
    db = createSchemaDatabase();
    loadRowFiles(db, canonicalQueryFixture());
    expect(checkIntegrity(db)).toEqual([]);
  });

  it('Q1 — a system’s chips and how many fpga_hdl implementations each has', () => {
    expect(
      rows(
        db,
        `SELECT sc.role_id                            AS role,
                c.chip_id,
                c.display_name,
                c.function_id,
                COALESCE(ic.implementation_count, 0)  AS fpga_hdl_implementations
         FROM system_chip sc
         JOIN chip c ON c.chip_id = sc.chip_id
         LEFT JOIN v_chip_implementation_count ic
                ON ic.chip_id = c.chip_id AND ic.kind_id = 'fpga_hdl'
         WHERE sc.system_id = :system_id
         ORDER BY sc.role_id, c.chip_id`,
        { system_id: 'sega-system16a' },
      ),
    ).toEqual([
      {
        role: 'audiocpu',
        chip_id: 'z80',
        display_name: 'Z80',
        function_id: 'cpu',
        fpga_hdl_implementations: 1,
      },
      {
        role: 'maincpu',
        chip_id: 'm68000',
        display_name: 'MC68000',
        function_id: 'cpu',
        fpga_hdl_implementations: 1,
      },
      {
        role: 'sound',
        chip_id: 'ym2151',
        display_name: 'YM2151',
        function_id: 'sound-fm',
        fpga_hdl_implementations: 1,
      },
      {
        role: 'video',
        chip_id: 'sega-315-5011',
        display_name: 'Sega 315-5011',
        function_id: 'custom',
        fpga_hdl_implementations: 0,
      },
    ]);
  });

  it('Q2 — the Prospector emits a row per (platform, system) with no core', () => {
    // `confidence`, `chips_equivalent` and `chips_provided` are here because v_prospector
    // is now built on v_system_coverage_by_kind rather than on a private fpga-only copy
    // of the same arithmetic. The specialised copy could not compute them (MAJOR 3).
    expect(
      rows(
        db,
        `SELECT p.platform_id, p.system_id, p.chips_total, p.chips_equivalent,
                p.chips_provided, p.chips_satisfied,
                ROUND(100.0 * p.satisfied_share, 1) AS satisfied_pct,
                p.unmapped_device_count, p.confidence
         FROM v_prospector p
         JOIN system s ON s.system_id = p.system_id
         ORDER BY p.satisfied_share DESC, p.unmapped_device_count ASC,
                  p.chips_total DESC, p.system_id`,
      ),
    ).toEqual([
      {
        platform_id: 'pocket',
        system_id: 'sega-system16a',
        chips_total: 4,
        chips_equivalent: 0,
        chips_provided: 0,
        chips_satisfied: 3,
        satisfied_pct: 75.0,
        unmapped_device_count: 1,
        confidence: 'medium',
      },
    ]);
    // `mister` is absent because mister-arcade-s16a already targets it: the whole point
    // of the view is that a system with a core is not a prospect on that platform.
  });

  it('Q3 — a core resolves to the HDL paths behind every chip implementation it consumes', () => {
    expect(
      rows(
        db,
        `WITH RECURSIVE consumed(implementation_id, depth) AS (
           SELECT provider_id, 1 FROM implementation_dependency WHERE consumer_id = :core
           UNION
           SELECT d.provider_id, c.depth + 1
           FROM implementation_dependency d
           JOIN consumed c ON d.consumer_id = c.implementation_id
         )
         SELECT co.depth, i.implementation_id, ic.chip_id, ip.path, ip.is_top, i.license_id
         FROM consumed co
         JOIN implementation i        ON i.implementation_id = co.implementation_id
         LEFT JOIN project pr         ON pr.project_id = i.project_id
         LEFT JOIN implementation_chip ic ON ic.implementation_id = i.implementation_id
         LEFT JOIN implementation_path ip ON ip.implementation_id = i.implementation_id
         WHERE i.kind_id = 'fpga_hdl'
         ORDER BY co.depth, i.implementation_id, ip.is_top DESC, ip.path`,
        { core: 'mister-arcade-s16a' },
      ),
    ).toEqual([
      {
        depth: 1,
        implementation_id: 'fx68k',
        chip_id: 'm68000',
        path: 'fx68k.sv',
        is_top: 1,
        license_id: null,
      },
      {
        depth: 1,
        implementation_id: 'jt51',
        chip_id: 'ym2151',
        path: 'hdl/jt51.v',
        is_top: 1,
        license_id: 'GPL-3.0-only',
      },
      {
        depth: 1,
        implementation_id: 'jt51',
        chip_id: 'ym2151',
        path: 'hdl/jt51_op.v',
        is_top: 0,
        license_id: 'GPL-3.0-only',
      },
      {
        depth: 1,
        implementation_id: 't80',
        chip_id: 'z80',
        path: 'T80.vhd',
        is_top: 1,
        license_id: null,
      },
    ]);
  });

  it('Q3 read backwards is v1’s known_consumers[], with no stored column', () => {
    expect(
      rows(db, `SELECT consumer_id FROM implementation_dependency WHERE provider_id = 'jt51'`),
    ).toEqual([{ consumer_id: 'mister-arcade-s16a' }]);
  });

  it('Q4 — chips with no satisfying fpga_hdl implementation, ranked by usage', () => {
    expect(
      rows(
        db,
        `SELECT chip_id, display_name, function_id, prospector_band, system_count, machine_count
         FROM v_chip_gap
         WHERE kind_id = 'fpga_hdl'
         ORDER BY system_count DESC, machine_count DESC, chip_id`,
      ),
    ).toEqual([
      {
        chip_id: 'sega-315-5011',
        display_name: 'Sega 315-5011',
        function_id: 'custom',
        prospector_band: 'hard',
        system_count: 1,
        machine_count: 1,
      },
    ]);
  });

  it('Q5 — coverage for one system, from the one view that defines it', () => {
    // MAJOR 3: v_system_coverage is deleted. There was never a second metric, only a
    // second SQL definition of the same one; the generic view is the survivor.
    expect(
      rows(
        db,
        `SELECT system_id, chips_total, chips_direct, chips_satisfied, satisfied_share,
                unmapped_device_count, confidence
         FROM v_system_coverage_by_kind
         WHERE system_id = :system_id AND kind_id = 'fpga_hdl'`,
        { system_id: 'sega-system16a' },
      ),
    ).toEqual([
      {
        system_id: 'sega-system16a',
        chips_total: 4,
        chips_direct: 3,
        chips_satisfied: 3,
        satisfied_share: 0.75,
        unmapped_device_count: 1,
        confidence: 'medium',
      },
    ]);
  });

  it('Q5 — the per-chip explanation, whose unsatisfied rows are v1’s missing[]', () => {
    expect(
      rows(
        db,
        `SELECT chip_id, satisfied_via, provider_chip_id
         FROM v_system_chip_coverage
         WHERE system_id = :system_id AND kind_id = 'fpga_hdl'
         ORDER BY chip_id`,
        { system_id: 'sega-system16a' },
      ),
    ).toEqual([
      { chip_id: 'm68000', satisfied_via: 'self', provider_chip_id: 'm68000' },
      { chip_id: 'sega-315-5011', satisfied_via: 'unsatisfied', provider_chip_id: null },
      { chip_id: 'ym2151', satisfied_via: 'self', provider_chip_id: 'ym2151' },
      { chip_id: 'z80', satisfied_via: 'self', provider_chip_id: 'z80' },
    ]);
  });

  it('v_machine resolves MAME’s free text into normalized facts', () => {
    // No manufacturer_alias row exists for 'Sega', so manufacturer_id stays NULL rather
    // than being guessed — standing rule 3, expressed as a LEFT JOIN.
    expect(
      rows(db, `SELECT machine_id, name, system_id, year, manufacturer_id FROM v_machine`),
    ).toEqual([
      {
        machine_id: 'shinobi',
        name: 'Shinobi (set 6, System 16A)',
        system_id: 'sega-system16a',
        year: 1987,
        manufacturer_id: null,
      },
    ]);
  });

  it('v_machine_bom unions the title’s own rows with its system’s, without duplicating any', () => {
    expect(
      rows(
        db,
        `SELECT chip_id, role, via FROM v_machine_bom WHERE machine_id = 'shinobi' ORDER BY chip_id`,
      ),
    ).toEqual([
      { chip_id: 'm68000', role: 'maincpu', via: 'machine' },
      { chip_id: 'sega-315-5011', role: 'gfx', via: 'machine' },
      { chip_id: 'ym2151', role: 'ym2151', via: 'machine' },
      { chip_id: 'z80', role: 'audiocpu', via: 'machine' },
    ]);
  });
});

interface CoverageRow {
  readonly kind_id: string;
  readonly system_id: string;
  readonly chips_total: number;
  readonly chips_direct: number;
  readonly chips_equivalent: number;
  readonly chips_provided: number;
  readonly chips_satisfied: number;
  readonly pct: number;
  readonly unmapped_device_count: number;
  readonly confidence: string;
}

/** docs/coverage.md §6.9, verbatim. `pct` is ROUND(100.0 * satisfied_share, 1). */
const REGRESSION_TABLE: readonly CoverageRow[] = [
  {
    kind_id: FPGA,
    system_id: 'fx-symmetric',
    chips_total: 4,
    chips_direct: 2,
    chips_equivalent: 1,
    chips_provided: 0,
    chips_satisfied: 3,
    pct: 75.0,
    unmapped_device_count: 0,
    confidence: 'medium',
  },
  {
    kind_id: FPGA,
    system_id: 'fx-68k-hit',
    chips_total: 2,
    chips_direct: 1,
    chips_equivalent: 0,
    chips_provided: 1,
    chips_satisfied: 2,
    pct: 100.0,
    unmapped_device_count: 0,
    confidence: 'medium',
  },
  {
    kind_id: FPGA,
    system_id: 'fx-68k-miss',
    chips_total: 3,
    chips_direct: 2,
    chips_equivalent: 0,
    chips_provided: 0,
    chips_satisfied: 2,
    pct: 66.7,
    unmapped_device_count: 0,
    confidence: 'high',
  },
  {
    kind_id: FPGA,
    system_id: 'fx-68k-notrans',
    chips_total: 2,
    chips_direct: 1,
    chips_equivalent: 0,
    chips_provided: 0,
    chips_satisfied: 1,
    pct: 50.0,
    unmapped_device_count: 0,
    confidence: 'high',
  },
  {
    kind_id: FPGA,
    system_id: 'fx-2a03',
    chips_total: 3,
    chips_direct: 2,
    chips_equivalent: 0,
    chips_provided: 0,
    chips_satisfied: 2,
    pct: 66.7,
    unmapped_device_count: 0,
    confidence: 'high',
  },
  {
    kind_id: FPGA,
    system_id: 'fx-unmapped-med',
    chips_total: 5,
    chips_direct: 5,
    chips_equivalent: 0,
    chips_provided: 0,
    chips_satisfied: 5,
    pct: 100.0,
    unmapped_device_count: 1,
    confidence: 'medium',
  },
  {
    kind_id: FPGA,
    system_id: 'fx-unmapped-low',
    chips_total: 4,
    chips_direct: 4,
    chips_equivalent: 0,
    chips_provided: 0,
    chips_satisfied: 4,
    pct: 100.0,
    unmapped_device_count: 2,
    confidence: 'low',
  },
  {
    kind_id: FPGA,
    system_id: 'fx-kind',
    chips_total: 3,
    chips_direct: 1,
    chips_equivalent: 0,
    chips_provided: 0,
    chips_satisfied: 1,
    pct: 33.3,
    unmapped_device_count: 0,
    confidence: 'high',
  },
  {
    kind_id: 'software_emulation',
    system_id: 'fx-kind',
    chips_total: 3,
    chips_direct: 3,
    chips_equivalent: 0,
    chips_provided: 0,
    chips_satisfied: 3,
    pct: 100.0,
    unmapped_device_count: 0,
    confidence: 'high',
  },
  {
    kind_id: 'original_silicon',
    system_id: 'fx-kind',
    chips_total: 3,
    chips_direct: 0,
    chips_equivalent: 0,
    chips_provided: 0,
    chips_satisfied: 0,
    pct: 0.0,
    unmapped_device_count: 0,
    confidence: 'high',
  },
];

const COVERAGE_SQL = `
SELECT kind_id, system_id, chips_total, chips_direct, chips_equivalent, chips_provided,
       chips_satisfied, ROUND(100.0 * satisfied_share, 1) AS pct,
       unmapped_device_count, confidence
FROM v_system_coverage_by_kind
WHERE system_id = :system_id AND kind_id = :kind_id`;

describe('coverage.md §6 — the worked examples', () => {
  let db: DatabaseSync;

  beforeAll(() => {
    db = createSchemaDatabase();
    loadRowFiles(db, coverageFixture());
    expect(checkIntegrity(db)).toEqual([]);
  });

  it('§6.0 — v_chip_evidence at fpga_hdl is the shared input to E1–E7', () => {
    const evidence = rows(
      db,
      `SELECT chip_id, evidence_rank, best_via, confidence, provider_chip_id
       FROM v_chip_evidence
       WHERE kind_id = 'fpga_hdl' AND chip_id NOT GLOB 'fx-*'
       ORDER BY chip_id`,
    );
    expect(evidence).toEqual([
      {
        chip_id: 'm68010',
        evidence_rank: 3,
        best_via: 'provides',
        confidence: 'low',
        provider_chip_id: 'm68020',
      },
      {
        chip_id: 'm68020',
        evidence_rank: 1,
        best_via: 'self',
        confidence: 'high',
        provider_chip_id: 'm68020',
      },
      {
        chip_id: 'rp2a03',
        evidence_rank: 1,
        best_via: 'self',
        confidence: 'high',
        provider_chip_id: 'rp2a03',
      },
      {
        chip_id: 'sn76489',
        evidence_rank: 1,
        best_via: 'self',
        confidence: 'high',
        provider_chip_id: 'sn76489',
      },
      {
        chip_id: 'ym2612',
        evidence_rank: 2,
        best_via: 'equivalent',
        confidence: 'medium',
        provider_chip_id: 'ym3438',
      },
      {
        chip_id: 'ym3438',
        evidence_rank: 1,
        best_via: 'self',
        confidence: 'high',
        provider_chip_id: 'ym3438',
      },
      {
        chip_id: 'z80',
        evidence_rank: 1,
        best_via: 'self',
        confidence: 'high',
        provider_chip_id: 'z80',
      },
    ]);
  });

  for (const expected of REGRESSION_TABLE) {
    it(`${expected.system_id} @ ${expected.kind_id} is ${expected.chips_satisfied}/${expected.chips_total} = ${expected.pct}% at ${expected.confidence}`, () => {
      expect(
        rows(db, COVERAGE_SQL, { system_id: expected.system_id, kind_id: expected.kind_id }),
      ).toEqual([expected]);
    });
  }

  it('the invariants of §3.5 hold for every row', () => {
    const all = db
      .prepare(
        `SELECT chips_total, chips_direct, chips_equivalent, chips_provided, chips_satisfied,
                satisfied_share, confidence
         FROM v_system_coverage_by_kind`,
      )
      .all();
    expect(all.length).toBeGreaterThan(0);
    for (const row of all) {
      const total = Number(row['chips_total']);
      const satisfied = Number(row['chips_satisfied']);
      expect(
        Number(row['chips_direct']) +
          Number(row['chips_equivalent']) +
          Number(row['chips_provided']),
      ).toBe(satisfied);
      expect(satisfied).toBeLessThanOrEqual(total);
      if (total === 0) {
        expect(row['satisfied_share']).toBe(0.0);
        expect(row['confidence']).toBe('low');
      }
    }
  });

  it('satisfied_via = unsatisfied ⟺ evidence_rank = 4 ⟺ chip_confidence IS NULL', () => {
    const violations = rows(
      db,
      `SELECT chip_id FROM v_system_chip_coverage
       WHERE (satisfied_via = 'unsatisfied') <> (evidence_rank = 4)
          OR (evidence_rank = 4) <> (chip_confidence IS NULL)`,
    );
    expect(violations).toEqual([]);
  });

  it('E1 — the symmetric edge fires in the direction that is not on disk', () => {
    expect(
      rows(
        db,
        `SELECT chip_id, satisfied_via, evidence_rank, provider_chip_id, chip_confidence
         FROM v_system_chip_coverage
         WHERE kind_id = 'fpga_hdl' AND system_id = 'fx-symmetric'
         ORDER BY chip_id`,
      ),
    ).toEqual([
      {
        chip_id: 'sega-315-5011',
        satisfied_via: 'unsatisfied',
        evidence_rank: 4,
        provider_chip_id: null,
        chip_confidence: null,
      },
      {
        chip_id: 'sn76489',
        satisfied_via: 'self',
        evidence_rank: 1,
        provider_chip_id: 'sn76489',
        chip_confidence: 'high',
      },
      {
        chip_id: 'ym2612',
        satisfied_via: 'equivalent',
        evidence_rank: 2,
        provider_chip_id: 'ym3438',
        chip_confidence: 'medium',
      },
      {
        chip_id: 'z80',
        satisfied_via: 'self',
        evidence_rank: 1,
        provider_chip_id: 'z80',
        chip_confidence: 'high',
      },
    ]);
    // The stored row is (ym2612 -> ym3438); the socket here is ym2612.
    expect(
      rows(db, `SELECT COUNT(*) AS n FROM chip_equivalence WHERE from_chip_id = 'ym3438'`),
    ).toEqual([{ n: 0 }]);
  });

  it('E3 — the same edge family in the wrong direction does not satisfy', () => {
    expect(
      rows(
        db,
        `SELECT satisfied_via FROM v_system_chip_coverage
         WHERE kind_id = 'fpga_hdl' AND system_id = 'fx-68k-miss' AND chip_id = 'm68030'`,
      ),
    ).toEqual([{ satisfied_via: 'unsatisfied' }]);
  });

  it('E4 — two hops is not one hop, so m68000 stays unsatisfied', () => {
    expect(
      rows(
        db,
        `SELECT satisfied_via FROM v_system_chip_coverage
         WHERE kind_id = 'fpga_hdl' AND system_id = 'fx-68k-notrans' AND chip_id = 'm68000'`,
      ),
    ).toEqual([{ satisfied_via: 'unsatisfied' }]);
  });

  it('E5 — the 2A03 is covered and the 6502 beside it is not', () => {
    expect(
      rows(
        db,
        `SELECT chip_id, satisfied_via FROM v_system_chip_coverage
         WHERE kind_id = 'fpga_hdl' AND system_id = 'fx-2a03' AND chip_id IN ('m6502', 'rp2a03')
         ORDER BY chip_id`,
      ),
    ).toEqual([
      { chip_id: 'm6502', satisfied_via: 'unsatisfied' },
      { chip_id: 'rp2a03', satisfied_via: 'self' },
    ]);
  });

  describe('§6.9 — additional verified behaviours', () => {
    it('a system with no BOM yields one row per kind at 0.0 and low', () => {
      expect(
        rows(
          db,
          `SELECT kind_id, chips_total, satisfied_share, confidence
           FROM v_system_coverage_by_kind WHERE system_id = 'fx-empty' ORDER BY kind_id`,
        ),
      ).toEqual([
        { kind_id: 'fpga_hdl', chips_total: 0, satisfied_share: 0.0, confidence: 'low' },
        { kind_id: 'original_silicon', chips_total: 0, satisfied_share: 0.0, confidence: 'low' },
        { kind_id: 'software_emulation', chips_total: 0, satisfied_share: 0.0, confidence: 'low' },
      ]);
    });

    it('the best route wins: a chip that is both direct and reachable reads as direct', () => {
      expect(
        rows(
          db,
          `SELECT evidence_rank, best_via FROM v_chip_evidence WHERE kind_id = 'fpga_hdl' AND chip_id = 'ym3438'`,
        ),
      ).toEqual([{ evidence_rank: 1, best_via: 'self' }]);
    });

    it('two implementations of one chip and kind collapse to one row', () => {
      expect(
        rows(db, `SELECT COUNT(*) AS n FROM implementation_chip WHERE chip_id = 'z80'`),
      ).toEqual([{ n: 3 }]);
      expect(
        rows(
          db,
          `SELECT COUNT(*) AS n FROM v_chip_satisfied WHERE chip_id = 'z80' AND kind_id = 'fpga_hdl'`,
        ),
      ).toEqual([{ n: 1 }]);
    });

    it('two providers tied at one rank resolve to MIN(provider_chip_id)', () => {
      expect(
        rows(
          db,
          `SELECT evidence_rank, provider_chip_id FROM v_chip_evidence WHERE kind_id = 'fpga_hdl' AND chip_id = 'fx-tie-socket'`,
        ),
      ).toEqual([{ evidence_rank: 3, provider_chip_id: 'fx-tie-hi' }]);
    });

    it('V10 is retired: coverage has one definition, so there is nothing to reconcile', () => {
      // The old V10 gate compared v_system_coverage against v_system_coverage_by_kind
      // @ fpga_hdl and found them identical — which was the finding, not the assurance:
      // two SQL definitions of the headline metric that had to be edited in lockstep.
      expect(
        rows(
          db,
          `SELECT name FROM sqlite_schema WHERE name GLOB 'v_*fpga*' OR name = 'v_system_coverage'`,
        ),
      ).toEqual([]);
      // v_prospector now *reads* the generic view, so agreement is structural.
      expect(
        rows(
          db,
          `SELECT p.system_id
           FROM v_prospector p
           JOIN v_system_coverage_by_kind c
             ON c.system_id = p.system_id AND c.kind_id = 'fpga_hdl'
           WHERE p.chips_total     <> c.chips_total
              OR p.chips_direct    <> c.chips_direct
              OR p.chips_satisfied <> c.chips_satisfied
              OR p.satisfied_share <> c.satisfied_share
              OR p.confidence      <> c.confidence`,
        ),
      ).toEqual([]);
      expect(
        rows(db, `SELECT COUNT(*) AS n FROM v_system_coverage_by_kind WHERE kind_id = 'fpga_hdl'`),
      ).toEqual([{ n: 9 }]);
    });

    it('V5 — an injected provides cycle is detected and evaluation is unaffected', () => {
      const before = rows(
        db,
        `SELECT * FROM v_chip_evidence WHERE kind_id = 'fpga_hdl' ORDER BY chip_id`,
      );
      const cycleQuery = `
        WITH RECURSIVE reach(a, b) AS (
          SELECT from_chip_id, to_chip_id FROM chip_equivalence WHERE kind = 'provides'
          UNION
          SELECT r.a, e.to_chip_id
          FROM reach r JOIN chip_equivalence e ON e.from_chip_id = r.b AND e.kind = 'provides'
        )
        SELECT a AS chip_id FROM reach WHERE a = b ORDER BY a`;
      expect(rows(db, cycleQuery)).toEqual([]);

      db.exec(
        `INSERT INTO chip_equivalence VALUES ('m68000', 'm68030', 'provides',
          'Fixture-only edge that closes the 68k ladder into a cycle, to exercise the V5 detector.')`,
      );
      expect(rows(db, cycleQuery)).toEqual([
        { chip_id: 'm68000' },
        { chip_id: 'm68010' },
        { chip_id: 'm68020' },
        { chip_id: 'm68030' },
      ]);
      expect(
        rows(db, `SELECT * FROM v_chip_evidence WHERE kind_id = 'fpga_hdl' ORDER BY chip_id`),
      ).toEqual(before);
      db.exec(
        `DELETE FROM chip_equivalence WHERE from_chip_id = 'm68000' AND to_chip_id = 'm68030'`,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// The quality views, on the points the schema review moved
// ---------------------------------------------------------------------------

describe('data-quality.md §4 — the warning branches the schema review changed', () => {
  let db: DatabaseSync;

  beforeAll(() => {
    db = createSchemaDatabase();
    loadRowFiles(db, coverageFixture());
    db.exec(`
      INSERT INTO chip_family VALUES ('z80', 'Z80 family', 'zilog', NULL);
      INSERT INTO manufacturer VALUES ('sharp', 'Sharp', 'JP', NULL);
      INSERT INTO chip (chip_id, display_name, function_id, manufacturer_id, family_id, description)
      VALUES ('lh0080', 'Sharp LH0080', 'cpu', 'sharp', 'z80', 'Sharp second source of the Zilog Z80.');
      INSERT INTO chip_name VALUES ('lh0080', 'Z80', 'alias');
      INSERT INTO system_name VALUES ('fx-2a03', 'FX empty', 'alias');
      INSERT INTO implementation (implementation_id, name, kind_id)
      VALUES ('fx-s16a-pcb', 'FX System 16A PCB', 'original_silicon');
      INSERT INTO implementation_system VALUES ('fx-s16a-pcb', 'fx-symmetric');
    `);
  });

  it('MINOR 7 — original silicon raises no licence or accuracy warning it could never clear', () => {
    // The row has neither license_id nor accuracy_id, and the DDL forbids it from ever
    // having them. Before the kind filter, it emitted two permanently unclearable rows.
    expect(
      rows(db, `SELECT code FROM v_quality_warning WHERE subject = 'fx-s16a-pcb' ORDER BY code`),
    ).toEqual([]);
    // The same two branches still fire for a kind that can carry those attributes.
    expect(
      rows(
        db,
        `SELECT COUNT(*) AS n FROM v_quality_warning
         WHERE code IN ('IMPL_UNVERIFIED_LICENSE', 'IMPL_UNVERIFIED_ACCURACY')`,
      ),
    ).toEqual([{ n: 24 }]);
  });

  it('MINOR 11 — a display name that is also another entity’s alias is reported', () => {
    // ux_chip_name_name makes chip_name.name unique, but chip.display_name sits outside
    // it: 'Z80' is chip z80's display name *and* chip lh0080's alias, so the resolver
    // would answer with lh0080 for a string that names z80.
    expect(
      rows(db, `SELECT code, subject FROM v_quality_warning WHERE code LIKE '%NAME_COLLISION'`),
    ).toEqual([
      { code: 'CHIP_NAME_COLLISION', subject: 'z80' },
      { code: 'SYSTEM_NAME_COLLISION', subject: 'fx-empty' },
    ]);
  });

  it('MINOR 12 — a second source is a warning, not a constraint', () => {
    expect(
      rows(
        db,
        `SELECT subject, detail FROM v_quality_warning
         WHERE code = 'CHIP_MANUFACTURER_FAMILY_MISMATCH'`,
      ),
    ).toEqual([
      {
        subject: 'lh0080',
        detail: "chip manufacturer differs from its family's manufacturer",
      },
    ]);
  });
});
