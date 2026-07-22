/**
 * SPIKE — throwaway scaffolding for ADR 0001 (browser database choice).
 *
 * Not part of the pipeline. Nothing imports it except its sibling spike
 * `verify-browser-engines.ts`; the CLI does not dispatch it.
 *
 * It exists to answer two questions with measurements instead of estimates:
 * how big is the published SQLite file at realistic scale, and how fast do the
 * canonical queries run against it?
 *
 * It builds a synthetic database at the T1.8 scale estimate using the SHIPPED
 * DDL — `schemas/schema.sql`, the same file the loader applies — so the schema
 * under test is the real one, all 36 tables and all 21 views, not an extract.
 * It then reports on-disk size, gzip -9 and brotli -q 11 transfer sizes, and
 * timings for canonical queries Q1, Q2, Q4 and Q5.
 *
 * Run:  npx tsx pipeline/src/spike/build-fixture-db.ts
 * Delete once ADR 0001 is accepted and the real builder (T5.x) exists.
 */

import { DatabaseSync } from 'node:sqlite';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
/** The shipped schema, verbatim. Not an extract from a document. */
export const SCHEMA_SQL_PATH = join(REPO, 'schemas', 'schema.sql');
// Written outside the repo: the fixture is throwaway and must never be committed.
const OUT_DIR = join(tmpdir(), 'bomsquad-spike');
/** Where `buildFixtureDatabase()` leaves the file it built. */
export const FIXTURE_DB_PATH = join(OUT_DIR, 'fixture.sqlite');

/* ------------------------------------------------------------------ scale */

/** Synthetic row counts. Chosen to match the T1.8 realistic-scale estimate. */
const SCALE = {
  machines: 14_000,
  chips: 5_000,
  systems: 400,
  chipImplementations: 500,
  systemImplementations: 300,
  chipsPerMachine: 10,
  unmappedPerMachine: 2,
  chipsPerSystem: 12,
  namesPerChip: 2,
  pathsPerImplementation: 15,
  machinesPerCore: 20,
  equivalences: 800,
  mameDevices: 3_000,
  /** Machines given an explicit per-machine system assignment (one driver, two systems). */
  machineSystemRows: 200,
  /**
   * Chips drawn on per system. Machines of one driver family share a board, so
   * their chips overlap heavily; drawing each machine's chips uniformly from all
   * 5 000 chips would make `v_system_chip_effective` ~10x wider than reality.
   * `outlierShare` is the fraction of machine chips drawn globally instead.
   */
  chipPoolPerSystem: 25,
  outlierShare: 0.05,
} as const;

/* ------------------------------------------------------- deterministic RNG */

/** mulberry32 — small, seeded, reproducible. Same seed ⇒ same database. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SEED = 20260722;
/** Re-seeded at the start of every build so two builds in one process agree. */
let rand = rng(SEED);
const pick = <T>(xs: readonly T[]): T => {
  const v = xs[Math.floor(rand() * xs.length)];
  if (v === undefined) throw new Error('empty pool');
  return v;
};
const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));

/* ------------------------------------------------------------ schema input */

/** The shipped DDL, read whole. */
export function schemaSql(): string {
  return readFileSync(SCHEMA_SQL_PATH, 'utf8');
}

/* -------------------------------------------------------------- generators */

const FUNCTIONS = [
  ['cpu', 'CPU', 'hard'],
  ['sound-fm', 'FM sound', 'hard'],
  ['sound-pcm', 'PCM sound', 'medium'],
  ['video-sprite', 'Sprite generator', 'hard'],
  ['video-tilemap', 'Tilemap generator', 'medium'],
  ['io', 'I/O', 'soft'],
  ['custom', 'Custom / unidentified', 'soft'],
] as const;

const MANUFACTURERS = [
  'sega',
  'capcom',
  'namco',
  'konami',
  'taito',
  'motorola',
  'zilog',
  'yamaha',
  'intel',
  'nec',
] as const;

const PLATFORMS = ['mister', 'analogue-pocket', 'mistex', 'replay', 'de10-nano'] as const;
const ROLES = ['maincpu', 'audiocpu', 'sound', 'video', 'io', 'gfx', 'protection'] as const;
const IMPL_KINDS = ['fpga_hdl', 'software_emulation', 'original_silicon'] as const;

/** Thresholds mirror pipeline/config/quality-thresholds.json; the quality views read them. */
const THRESHOLDS: readonly (readonly [string, number])[] = [
  ['mapped_instance_share.warn_below', 0.7],
  ['issue_generator.min_instance_count', 50],
  ['issue_generator.min_machine_count', 5],
  ['stale_review_days', 365],
  ['system_unmapped_share.warn_above', 0.25],
];

/** MAME source files use the sourcefile grammar: [a-z0-9_/] then '.cpp'. */
const sourcefile = (systemIndex: number): string =>
  `drivers/synth/system_${String(systemIndex).padStart(4, '0')}.cpp`;

function load(db: DatabaseSync): void {
  const insert = (sql: string, rows: readonly (readonly unknown[])[]): void => {
    const st = db.prepare(sql);
    for (const r of rows) st.run(...(r as never[]));
  };

  // ---- lookups
  insert(
    'INSERT INTO manufacturer VALUES (?,?,?,NULL)',
    MANUFACTURERS.map((m) => [m, m.toUpperCase(), 'JP']),
  );
  insert(
    'INSERT INTO manufacturer_alias VALUES (?,?)',
    MANUFACTURERS.map((m) => [`${m} corp.`, m]),
  );
  insert('INSERT INTO license VALUES (?,?,?,?)', [
    ['GPL-3.0-only', 'GNU GPL v3', 'https://spdx.org/licenses/GPL-3.0-only.html', 1],
    ['MIT', 'MIT License', 'https://spdx.org/licenses/MIT.html', 1],
    ['NOASSERTION', 'Unknown', null, 0],
  ]);
  insert(
    'INSERT INTO chip_function VALUES (?,?,?,?)',
    FUNCTIONS.map(([id, label, band]) => [id, label, label, band]),
  );
  insert(
    'INSERT INTO chip_role VALUES (?,?,NULL)',
    ROLES.map((r) => [r, r]),
  );
  insert('INSERT INTO system_kind VALUES (?,?)', [
    ['arcade-board', 'Arcade board'],
    ['console', 'Console'],
  ]);
  insert('INSERT INTO hdl_language VALUES (?,?)', [
    ['verilog', 'Verilog'],
    ['vhdl', 'VHDL'],
    ['systemverilog', 'SystemVerilog'],
  ]);
  insert(
    'INSERT INTO fpga_platform VALUES (?,?,NULL)',
    PLATFORMS.map((p) => [p, p]),
  );
  insert(
    'INSERT INTO implementation_kind VALUES (?,?,?)',
    IMPL_KINDS.map((k) => [k, k, k]),
  );
  insert('INSERT INTO accuracy_level VALUES (?,?,?)', [
    ['cycle', 'Cycle accurate', 'Cycle accurate'],
    ['functional', 'Functional', 'Functional'],
  ]);
  insert(
    'INSERT INTO chip_family VALUES (?,?,?,NULL)',
    MANUFACTURERS.map((m) => [`${m}-family`, `${m} family`, m]),
  );
  insert(
    'INSERT INTO threshold VALUES (?,?)',
    THRESHOLDS.map(([name, value]) => [name, value]),
  );

  // ---- chips
  const chipIds: string[] = [];
  const chipRows: unknown[][] = [];
  const chipNameRows: unknown[][] = [];
  const chipSheetRows: unknown[][] = [];
  for (let i = 0; i < SCALE.chips; i++) {
    const id = `chip-${String(i).padStart(5, '0')}`;
    chipIds.push(id);
    const mfr = pick(MANUFACTURERS);
    chipRows.push([
      id,
      `Chip ${i} custom gate array`,
      pick(FUNCTIONS)[0],
      mfr,
      `${mfr}-family`,
      `MB-${1000 + i}`,
      'Synthetic fixture chip used only for the ADR 0001 sizing spike.',
      int(1_000_000, 20_000_000),
      'DIP-40',
      int(1975, 1998),
      null,
    ]);
    for (let n = 0; n < SCALE.namesPerChip; n++) {
      chipNameRows.push([id, `${id}-alias-${n}`, n === 0 ? 'alias' : 'retired_id']);
    }
    chipSheetRows.push([id, `https://example.invalid/datasheets/${id}.pdf`, `${id} datasheet`]);
  }
  insert('INSERT INTO chip VALUES (?,?,?,?,?,?,?,?,?,?,?)', chipRows);
  insert('INSERT INTO chip_name VALUES (?,?,?)', chipNameRows);
  insert('INSERT INTO chip_datasheet VALUES (?,?,?)', chipSheetRows);

  // ---- the MAME device catalogue: mapped xor ignored
  const deviceRows: unknown[][] = [];
  for (let i = 0; i < SCALE.mameDevices; i++) {
    const key = `mame_device_${String(i).padStart(4, '0')}`;
    deviceRows.push(
      i % 3 === 0
        ? [key, null, 'not a distinct part — bus glue', null]
        : [key, pick(chipIds), null, 'Synthetic mapping.'],
    );
  }
  insert('INSERT INTO mame_device VALUES (?,?,?,?)', deviceRows);

  // ---- equivalences (from < to for 'equivalent')
  const seen = new Set<string>();
  const equivRows: unknown[][] = [];
  while (equivRows.length < SCALE.equivalences) {
    const a = pick(chipIds);
    const b = pick(chipIds);
    if (a === b) continue;
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const key = `${lo}|${hi}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = rand() < 0.6 ? 'equivalent' : 'provides';
    equivRows.push([lo, hi, kind, 'Synthetic equivalence for the spike.']);
  }
  insert('INSERT INTO chip_equivalence VALUES (?,?,?,?)', equivRows);

  // ---- systems + BOM + drivers
  const systemIds: string[] = [];
  const systemPool: string[][] = [];
  const sysRows: unknown[][] = [];
  const sysChipRows: unknown[][] = [];
  const drvRows: unknown[][] = [];
  for (let i = 0; i < SCALE.systems; i++) {
    const id = `system-${String(i).padStart(4, '0')}`;
    systemIds.push(id);
    sysRows.push([
      id,
      `Synthetic System ${i}`,
      'arcade-board',
      pick(MANUFACTURERS),
      int(1980, 1996),
      'Synthetic fixture system.',
      null,
    ]);
    drvRows.push([sourcefile(i), id]);
    const pool = new Set<string>();
    while (pool.size < SCALE.chipPoolPerSystem) pool.add(pick(chipIds));
    systemPool.push([...pool]);
    const used = new Set<string>();
    for (let c = 0; c < SCALE.chipsPerSystem; c++) {
      const chip = pick([...pool]);
      const role = pick(ROLES);
      const key = `${role}|${chip}`;
      if (used.has(key)) continue;
      used.add(key);
      sysChipRows.push([id, role, chip, 1, int(1_000_000, 16_000_000), null]);
    }
  }
  insert('INSERT INTO system VALUES (?,?,?,?,?,?,?)', sysRows);
  insert('INSERT INTO system_chip VALUES (?,?,?,?,?,?)', sysChipRows);
  insert('INSERT INTO system_driver VALUES (?,?)', drvRows);

  // ---- machines + machine_chip (the big table) + unmapped devices
  const machineIds: string[] = [];
  const machineRows: unknown[][] = [];
  const machineChipRows: unknown[][] = [];
  const unmappedRows: unknown[][] = [];
  for (let i = 0; i < SCALE.machines; i++) {
    const id = `mach${String(i).padStart(5, '0')}`;
    machineIds.push(id);
    const sysIdx = i % SCALE.systems;
    machineRows.push([
      id,
      `Synthetic Machine ${i} (World, rev A)`,
      sourcefile(sysIdx),
      String(int(1980, 1996)),
      `${pick(MANUFACTURERS)} corp.`,
      int(1, 9),
      pick(['good', 'imperfect', 'preliminary'] as const),
      0,
      0,
      0,
    ]);
    const pool = systemPool[sysIdx] ?? chipIds;
    for (let c = 0; c < SCALE.chipsPerMachine; c++) {
      // One MAME tag names one socket, and D6's partial unique index enforces it.
      const tag = `${pick(ROLES)}${c}`;
      const chip = rand() < SCALE.outlierShare ? pick(chipIds) : pick(pool);
      machineChipRows.push([id, tag, chip, int(1_000_000, 16_000_000), 1]);
    }
    for (let u = 0; u < SCALE.unmappedPerMachine; u++) {
      unmappedRows.push([id, `unknown_device_${int(0, 600)}`, 1]);
    }
  }
  insert('INSERT INTO machine VALUES (?,?,?,?,?,?,?,?,?,?)', machineRows);
  insert('INSERT INTO machine_chip VALUES (?,?,?,?,?)', machineChipRows);
  insert('INSERT OR IGNORE INTO machine_unmapped_device VALUES (?,?,?)', unmappedRows);

  // ---- per-machine system assignments (one driver .cpp, several systems)
  const msRows: unknown[][] = [];
  for (let i = 0; i < SCALE.machineSystemRows; i++) {
    const machine = machineIds[i * 37];
    if (machine === undefined) continue;
    msRows.push([machine, pick(systemIds), 'Synthetic per-machine assignment.']);
  }
  insert('INSERT OR IGNORE INTO machine_system VALUES (?,?,?)', msRows);

  // ---- projects and implementations
  const projectIds = Array.from({ length: 40 }, (_, i) => `project-${String(i).padStart(3, '0')}`);
  insert(
    'INSERT INTO project VALUES (?,?,?,?,NULL)',
    projectIds.map((p) => [p, p, `https://example.invalid/${p}`, 'Synthetic Author']),
  );

  const implRows: unknown[][] = [];
  const implChipRows: unknown[][] = [];
  const implSysRows: unknown[][] = [];
  const implPathRows: unknown[][] = [];
  const implPlatRows: unknown[][] = [];
  const implMachRows: unknown[][] = [];
  const implDepRows: unknown[][] = [];
  const chipImplIds: string[] = [];

  const mkImpl = (id: string, kind: string): void => {
    // D10: original silicon is the part as manufactured — no repo, no HDL language,
    // no SPDX licence, no accuracy. The generator obeys the CHECK rather than dodging it.
    const isSilicon = kind === 'original_silicon';
    const verified = rand() < 0.3 ? 1 : 0;
    implRows.push([
      id,
      `Implementation ${id}`,
      kind,
      pick(projectIds),
      isSilicon ? null : `https://example.invalid/repo/${id}`,
      kind === 'fpga_hdl' ? pick(['verilog', 'vhdl', 'systemverilog'] as const) : null,
      isSilicon ? null : pick(['GPL-3.0-only', 'MIT', 'NOASSERTION'] as const),
      isSilicon ? null : pick(['cycle', 'functional'] as const),
      verified,
      null,
      // Half the rows are deliberately older than stale_review_days so the
      // IMPL_STALE_REVIEW branch — the schema's only julianday() use — has work to do.
      rand() < 0.5 ? '2026-07-01' : '2019-01-15',
      // D7: verified_against_hardware = 1 requires a citation in notes.
      verified === 1 ? 'Verified against a synthetic board, ADR 0001 spike.' : null,
    ]);
    for (let p = 0; p < SCALE.pathsPerImplementation; p++) {
      implPathRows.push([id, `rtl/${id}/module_${p}.v`, p === 0 ? 1 : 0]);
    }
    if (kind === 'fpga_hdl') {
      const plats = new Set<string>([pick(PLATFORMS), pick(PLATFORMS)]);
      for (const p of plats) implPlatRows.push([id, p]);
    }
  };

  for (let i = 0; i < SCALE.chipImplementations; i++) {
    const kind = i % 5 === 0 ? 'software_emulation' : i % 7 === 0 ? 'original_silicon' : 'fpga_hdl';
    const id = `impl-chip-${String(i).padStart(4, '0')}`;
    chipImplIds.push(id);
    mkImpl(id, kind);
    const targets = new Set<string>([pick(chipIds)]);
    if (rand() < 0.2) targets.add(pick(chipIds));
    for (const t of targets) implChipRows.push([id, t]);
  }

  for (let i = 0; i < SCALE.systemImplementations; i++) {
    const id = `impl-core-${String(i).padStart(4, '0')}`;
    mkImpl(id, i % 6 === 0 ? 'software_emulation' : 'fpga_hdl');
    implSysRows.push([id, pick(systemIds)]);
    const deps = new Set<string>();
    for (let d = 0; d < int(1, 5); d++) deps.add(pick(chipImplIds));
    for (const p of deps) implDepRows.push([id, p, null]);
    const machs = new Set<string>();
    for (let m = 0; m < SCALE.machinesPerCore; m++) machs.add(pick(machineIds));
    for (const m of machs) implMachRows.push([id, m]);
  }

  insert('INSERT INTO implementation VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', implRows);
  insert('INSERT INTO implementation_chip VALUES (?,?)', implChipRows);
  insert('INSERT INTO implementation_system VALUES (?,?)', implSysRows);
  insert('INSERT INTO implementation_path VALUES (?,?,?)', implPathRows);
  insert('INSERT INTO implementation_platform VALUES (?,?)', implPlatRows);
  insert('INSERT INTO implementation_machine VALUES (?,?)', implMachRows);
  insert('INSERT INTO implementation_dependency VALUES (?,?,?)', implDepRows);

  // ---- build metadata. build_date is what IMPL_STALE_REVIEW measures against.
  insert('INSERT INTO dataset_meta VALUES (?,?)', [
    ['schema_version', '2.0.0'],
    ['mame_version', 'mame0288'],
    ['build_date', '2026-07-22'],
    ['fixture', 'synthetic — ADR 0001 spike'],
  ]);
}

/* -------------------------------------------------------------- queries */

/**
 * The canonical queries, verbatim from docs/data-model.md §6, with their
 * parameters bound as literals so every engine runs byte-identical SQL.
 * Q3 is omitted: it is a recursive traversal from a single core and touches
 * tens of rows, so it measures nothing.
 */
export const CANONICAL_QUERIES: readonly { readonly id: string; readonly sql: string }[] = [
  {
    id: 'Q1',
    sql: `SELECT sc.role_id AS role, c.chip_id, c.display_name, c.function_id,
       COALESCE(ic.implementation_count, 0) AS fpga_hdl_implementations
FROM system_chip sc
JOIN chip c ON c.chip_id = sc.chip_id
LEFT JOIN v_chip_implementation_count ic
       ON ic.chip_id = c.chip_id AND ic.kind_id = 'fpga_hdl'
WHERE sc.system_id = 'system-0042'
ORDER BY sc.role_id, c.chip_id`,
  },
  {
    id: 'Q2',
    sql: `SELECT p.system_id, s.name, p.chips_total, p.chips_satisfied, p.chips_equivalent,
       p.chips_provided, ROUND(100.0 * p.satisfied_share, 1) AS satisfied_pct,
       p.unmapped_device_count, p.confidence
FROM v_prospector p
JOIN system s ON s.system_id = p.system_id
WHERE p.platform_id = 'mister'
ORDER BY p.satisfied_share DESC, p.unmapped_device_count ASC, p.chips_total DESC, p.system_id`,
  },
  {
    id: 'Q4',
    sql: `SELECT chip_id, display_name, function_id, prospector_band, system_count, machine_count
FROM v_chip_gap
WHERE kind_id = 'fpga_hdl'
ORDER BY system_count DESC, machine_count DESC, chip_id`,
  },
  {
    id: 'Q5',
    sql: `SELECT * FROM v_system_coverage_by_kind
WHERE system_id = 'system-0042' AND kind_id = 'fpga_hdl'`,
  },
  {
    id: 'QW',
    sql: `SELECT code, COUNT(*) AS n FROM v_quality_warning GROUP BY code ORDER BY code`,
  },
];

function time(label: string, fn: () => number, runs = 5): void {
  const times: number[] = [];
  let rows = 0;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    rows = fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const best = times[0] ?? 0;
  const median = times[Math.floor(times.length / 2)] ?? 0;
  console.log(
    `${label.padEnd(4)} rows=${String(rows).padStart(6)}  best=${best.toFixed(1)} ms  median=${median.toFixed(1)} ms`,
  );
}

/* ------------------------------------------------------------------ main */

/**
 * Builds the fixture at {@link FIXTURE_DB_PATH} and returns that path.
 * Idempotent: the directory is wiped first, and the RNG is seeded, so two runs
 * produce byte-identical files.
 */
export function buildFixtureDatabase(): string {
  rand = rng(SEED);
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const db = new DatabaseSync(FIXTURE_DB_PATH);
  db.exec("PRAGMA journal_mode=DELETE; PRAGMA page_size=4096; PRAGMA encoding='UTF-8';");
  // The shipped DDL, whole. It sets page_size, encoding, foreign_keys and user_version itself.
  db.exec(schemaSql());
  db.exec('BEGIN');
  load(db);
  db.exec('COMMIT');

  const fkBad = db.prepare('PRAGMA foreign_key_check').all().length;
  if (fkBad > 0) throw new Error(`fixture has ${fkBad} foreign key violations`);
  db.exec('ANALYZE;');
  db.exec('VACUUM;');
  db.close();
  return FIXTURE_DB_PATH;
}

function main(): void {
  const t0 = performance.now();
  const path = buildFixtureDatabase();
  const buildMs = performance.now() - t0;

  const db = new DatabaseSync(path);
  const integrity = db.prepare('PRAGMA integrity_check').get();
  const counts = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM machine) m, (SELECT COUNT(*) FROM machine_chip) mc,
              (SELECT COUNT(*) FROM chip) c, (SELECT COUNT(*) FROM system_chip) sc,
              (SELECT COUNT(*) FROM implementation) i,
              (SELECT COUNT(*) FROM machine_unmapped_device) mu`,
    )
    .get();

  console.log(`build: ${buildMs.toFixed(0)} ms`);
  console.log('integrity_check:', JSON.stringify(integrity));
  console.log('row counts:', JSON.stringify(counts));

  console.log('\nlargest b-trees (dbstat, MiB):');
  for (const row of db
    .prepare(
      `SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name
       ORDER BY bytes DESC LIMIT 8`,
    )
    .all()) {
    const r = row as { name: string; bytes: number };
    console.log(`  ${r.name.padEnd(32)} ${(r.bytes / 1024 / 1024).toFixed(2)}`);
  }

  for (const q of CANONICAL_QUERIES) {
    const st = db.prepare(q.sql);
    time(q.id, () => st.all().length);
  }
  db.close();

  const bytes = readFileSync(path);
  const raw = statSync(path).size;
  const gz = gzipSync(bytes, { level: 9 }).length;
  const br = brotliCompressSync(bytes, {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
  }).length;
  const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(2)} MiB`;
  console.log(`db: ${path}`);
  console.log(`size raw=${mb(raw)} gzip-9=${mb(gz)} brotli-11=${mb(br)}`);

  // Determinism: the real builder will need it, so the fixture proves it is reachable.
  const first = createHash('sha256').update(bytes).digest('hex');
  const second = createHash('sha256').update(readFileSync(buildFixtureDatabase())).digest('hex');
  console.log(`sha256 run1=${first.slice(0, 16)}… run2=${second.slice(0, 16)}…`);
  console.log(`deterministic: ${first === second ? 'yes — byte-identical' : 'NO'}`);
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
