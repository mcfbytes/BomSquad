/**
 * TASKS T6.4 (integrity checks + quality report) and T6.5 (the database build).
 *
 * Every FAIL gate of docs/data-quality.md §3 is exercised the only way a gate can be
 * trusted — by seeding the defect it exists to catch and watching it trip. A gate that
 * has only ever been run against clean data is a gate nobody has tested.
 *
 * The dataset under test is `test/fixtures.ts`'s `canonicalQueryFixture`, written to a
 * temporary directory as real row files so the build reads them through the real loader.
 * Nothing here touches the repository's `data/`, `extract/` or `dist/`.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createSchemaDatabase } from '../src/db/schema.js';
import { describeTables } from '../src/db/introspect.js';
import { canonicalRowFileJson, type Row } from '../src/db/rowfiles.js';
import { loadRowFiles } from '../src/db/load.js';
import { loadThresholds } from '../src/db/thresholds.js';
import {
  applyCorrections,
  POST_CORRECTION_CHECKS,
  runIntegrityChecks,
  STALE_CORRECTION,
} from '../src/build/integrity.js';
import {
  collectQualityReport,
  formatQualityReport,
  reportRegistryDrift,
  reportSchemaCodes,
  validateQualityReport,
  warningCodeRegistry,
} from '../src/build/report.js';
import { brotliSize, databaseSizeLimit, loadBuildConfig } from '../src/build/size.js';
import { buildDatabase, BuildFailure, resolveBuildDate } from '../src/build/index.js';
import { canonicalQueryFixture, bundle } from './fixtures.js';
import type { RowFile } from '../src/db/rowfiles.js';
import type { TableInfo } from '../src/db/introspect.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const SCHEMAS_DIR = join(REPO_ROOT, 'schemas');
const THRESHOLDS: Record<string, unknown> = JSON.parse(
  readFileSync(join(REPO_ROOT, 'pipeline', 'config', 'quality-thresholds.json'), 'utf8'),
) as Record<string, unknown>;
const BUILD_DATE = '2026-01-01';

function liveSchema(): Map<string, TableInfo> {
  const db = createSchemaDatabase();
  const schema = new Map(describeTables(db).map((info) => [info.name, info]));
  db.close();
  return schema;
}
const SCHEMA = liveSchema();

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'bomsquad-t65-'));
}

/** `dataset_meta.mame_version` — T6.1's row file, which the build needs and never writes. */
const DATASET_META: RowFile = bundle('fixture://extract/dataset_meta.json', {
  dataset_meta: [{ key: 'mame_version', value: '0.288' }],
});

/**
 * Writes a fixture dataset to disk as row files, through the same canonical serialiser
 * T6.1 uses, so the build reads exactly the bytes a committed dataset would present.
 */
function writeDataset(dir: string, files: readonly RowFile[]): string {
  const root = join(dir, 'dataset');
  mkdirSync(root, { recursive: true });
  files.forEach((file, index) => {
    writeFileSync(join(root, `${index}.json`), canonicalRowFileJson(file.tables, SCHEMA));
  });
  return root;
}

/** The clean dataset, plus whatever extra bundles a test seeds a defect with. */
function dataset(...extra: readonly RowFile[]): RowFile[] {
  return [...canonicalQueryFixture(), DATASET_META, ...extra];
}

interface RunOptions {
  readonly thresholds?: Record<string, unknown>;
  readonly schemasDir?: string;
  readonly datasetVersion?: string;
}

/** Runs a whole build over a fixture dataset in a scratch tree. */
function build(files: readonly RowFile[], options: RunOptions = {}) {
  const dir = scratch();
  const root = writeDataset(dir, files);
  const outputDir = join(dir, 'dist');
  return {
    outputDir,
    result: buildDatabase({
      roots: [root],
      outputDir,
      buildDate: BUILD_DATE,
      thresholds: options.thresholds ?? THRESHOLDS,
      ...(options.schemasDir !== undefined ? { schemasDir: options.schemasDir } : {}),
      ...(options.datasetVersion !== undefined ? { datasetVersion: options.datasetVersion } : {}),
    }),
  };
}

/** Asserts a build fails, and returns the messages so the caller can name the code. */
function failure(files: readonly RowFile[], options: RunOptions = {}): readonly string[] {
  try {
    build(files, options);
  } catch (error) {
    if (error instanceof BuildFailure) return error.failures;
    throw error;
  }
  throw new Error('expected the build to fail, but it succeeded');
}

/** A loaded fixture database with thresholds and a build date, for the SQL-level tests. */
function loaded(files: readonly RowFile[]) {
  const db = createSchemaDatabase();
  loadRowFiles(db, files);
  loadThresholds(db, THRESHOLDS);
  db.prepare('INSERT OR REPLACE INTO dataset_meta (key, value) VALUES (?, ?)').run(
    'build_date',
    BUILD_DATE,
  );
  return db;
}

// ---------------------------------------------------------------------------
// The build, end to end
// ---------------------------------------------------------------------------

describe('a clean dataset builds, and the artifact is sound', () => {
  it('publishes both files and answers both pragmas cleanly', () => {
    const { result, outputDir } = build(dataset());
    expect(result.databasePath).toBe(join(outputDir, 'bomsquad.sqlite'));
    expect(existsSync(result.databasePath)).toBe(true);
    expect(existsSync(result.reportPath)).toBe(true);
    // The staging file must not survive a successful build.
    expect(existsSync(`${result.databasePath}.staging`)).toBe(false);

    const built = openReadOnly(result.databasePath);
    expect(built.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(built.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }]);
    // §4.3's recipe, observable in the published file.
    expect(built.prepare('PRAGMA page_size').get()).toEqual({ page_size: 4096 });
    expect(built.prepare('PRAGMA encoding').get()).toEqual({ encoding: 'UTF-8' });
    expect(built.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 });
    built.close();
  });

  it('is byte-identical on a second build from the same inputs (§3.2)', () => {
    const files = dataset();
    const first = build(files);
    const second = build(files);
    expect(second.result.sha256).toBe(first.result.sha256);
    expect(readFileSync(second.result.databasePath)).toEqual(
      readFileSync(first.result.databasePath),
    );
    expect(readFileSync(second.result.reportPath, 'utf8')).toBe(
      readFileSync(first.result.reportPath, 'utf8'),
    );
  });

  it('ships the correction tables and the quality views inside the database', () => {
    const { result } = build(dataset());
    const db = openReadOnly(result.databasePath);
    const objects = db
      .prepare(
        `SELECT type, COUNT(*) AS n FROM sqlite_schema
          WHERE name NOT LIKE 'sqlite_%' AND type IN ('table','view') GROUP BY type`,
      )
      .all();
    expect(objects).toEqual([
      { type: 'table', n: 36 },
      { type: 'view', n: 21 },
    ]);
    db.close();
  });

  it('defaults dataset_version to the build date (versioning.md §2)', () => {
    const { result } = build(dataset());
    expect(result.datasetVersion).toBe(BUILD_DATE);
    expect(result.report.dataset_version).toBe(BUILD_DATE);
  });
});

function openReadOnly(path: string): DatabaseSync {
  return new DatabaseSync(path, { readOnly: true });
}

// ---------------------------------------------------------------------------
// build_date — the one place a clock could leak in
// ---------------------------------------------------------------------------

describe('resolveBuildDate', () => {
  it('prefers an explicit date and rejects a malformed one', () => {
    expect(resolveBuildDate('2026-03-04', {})).toBe('2026-03-04');
    expect(() => resolveBuildDate('4 March 2026', {})).toThrow(/YYYY-MM-DD/);
  });

  it('falls back to SOURCE_DATE_EPOCH so an old commit rebuilds to its own date', () => {
    expect(resolveBuildDate(undefined, { SOURCE_DATE_EPOCH: '1767225600' })).toBe('2026-01-01');
    expect(() => resolveBuildDate(undefined, { SOURCE_DATE_EPOCH: 'yesterday' })).toThrow(
      /Unix timestamp/,
    );
  });

  it('falls back to today only when neither is given', () => {
    expect(resolveBuildDate(undefined, {})).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ---------------------------------------------------------------------------
// §3 — every FAIL gate, on a seeded defect
// ---------------------------------------------------------------------------

describe('data-quality.md §3 — each gate trips on a seeded bad fixture', () => {
  it('§3.4 STALE_CORRECTION — a correction whose target row is gone', () => {
    const messages = failure(
      dataset(
        bundle('fixture://correction.json', {
          machine_chip_correction: [
            {
              machine_id: 'shinobi',
              mame_tag: 'nosuchtag',
              chip_id: 'z80',
              op: 'remove',
              reason: 'Seeded stale correction.',
            },
          ],
        }),
      ),
    );
    expect(messages.join('\n')).toContain('STALE_CORRECTION');
    expect(messages.join('\n')).toContain('nosuchtag');
  });

  it('§3.3 RETIRED_ID_COLLISION — an alias that is also a live primary key', () => {
    const messages = failure(
      dataset(
        bundle('fixture://collision.json', {
          chip_name: [{ chip_id: 'ym2151', name: 'z80', kind: 'retired_id' }],
        }),
      ),
    );
    expect(messages.join('\n')).toContain('RETIRED_ID_COLLISION');
  });

  it('§3.5 STALE_EXTRACT — a device recorded unmapped that the dictionary now maps', () => {
    const messages = failure(
      dataset(
        bundle('fixture://mame_device.json', {
          mame_device: [{ mame_device: 'sega_315_5195', chip_id: 'sega-315-5011' }],
        }),
      ),
    );
    expect(messages.join('\n')).toContain('STALE_EXTRACT');
    expect(messages.join('\n')).toContain('sega_315_5195');
  });

  it('§3.6 DEPENDENCY_CYCLE — a cycle longer than the one-hop CHECK catches', () => {
    const messages = failure(
      dataset(
        bundle('fixture://cycle.json', {
          implementation_dependency: [
            { consumer_id: 'fx68k', provider_id: 'jt51' },
            { consumer_id: 'jt51', provider_id: 't80' },
            { consumer_id: 't80', provider_id: 'fx68k' },
          ],
        }),
      ),
    );
    expect(messages.join('\n')).toContain('DEPENDENCY_CYCLE');
  });

  it('§3.7 DATASET_META_INCOMPLETE — no mame_version row from extract/', () => {
    const messages = failure(canonicalQueryFixture());
    expect(messages.join('\n')).toContain('DATASET_META_INCOMPLETE');
    expect(messages.join('\n')).toContain('mame_version');
  });

  it('§3.1 DB_OVER_BUDGET — the ceiling, read from the threshold table', () => {
    const messages = failure(dataset(), { thresholds: { ...THRESHOLDS, db_max_bytes: 1024 } });
    expect(messages.join('\n')).toContain('DB_OVER_BUDGET');
  });

  it('§5.4 foreign_key_check still decides referential integrity', () => {
    const messages = failure(
      dataset(
        bundle('fixture://dangling.json', {
          machine_chip: [{ machine_id: 'shinobi', mame_tag: 'ghost', chip_id: 'nosuchchip' }],
        }),
      ),
    );
    expect(messages.join('\n')).toContain('foreign key violation');
  });

  it('publishes nothing when a gate trips — dist/ is left untouched', () => {
    const dir = scratch();
    const root = writeDataset(dir, canonicalQueryFixture());
    const outputDir = join(dir, 'dist');
    expect(() =>
      buildDatabase({ roots: [root], outputDir, buildDate: BUILD_DATE, thresholds: THRESHOLDS }),
    ).toThrow(BuildFailure);
    expect(existsSync(join(outputDir, 'bomsquad.sqlite'))).toBe(false);
    expect(existsSync(join(outputDir, 'bomsquad.sqlite.staging'))).toBe(false);
    expect(existsSync(join(outputDir, 'quality-report.json'))).toBe(false);
  });
});

describe('the checks are a list of (code, sql) pairs, run as one loop (§9)', () => {
  it('returns nothing on a clean dataset', () => {
    const db = loaded(dataset());
    db.prepare('INSERT OR REPLACE INTO dataset_meta (key, value) VALUES (?, ?)').run(
      'dataset_version',
      BUILD_DATE,
    );
    db.prepare('INSERT OR REPLACE INTO dataset_meta (key, value) VALUES (?, ?)').run(
      'schema_version',
      '2.0.0',
    );
    expect(runIntegrityChecks(db, [STALE_CORRECTION, ...POST_CORRECTION_CHECKS])).toEqual([]);
    db.close();
  });

  it('names every §3 code exactly once', () => {
    expect([STALE_CORRECTION, ...POST_CORRECTION_CHECKS].map((check) => check.code)).toEqual([
      'STALE_CORRECTION',
      'RETIRED_ID_COLLISION',
      'STALE_EXTRACT',
      'DEPENDENCY_CYCLE',
      'DATASET_META_INCOMPLETE',
    ]);
  });
});

// ---------------------------------------------------------------------------
// §5.1 — the correction pass, and the corrections that need no pass at all
// ---------------------------------------------------------------------------

describe('data-model.md §5.1 — corrections', () => {
  const corrections = (rows: readonly Row[]): RowFile =>
    bundle('fixture://correction.json', { machine_chip_correction: rows });

  it("op='remove' deletes the BOM row", () => {
    const db = loaded(
      dataset(
        corrections([
          {
            machine_id: 'shinobi',
            mame_tag: 'ym2151',
            chip_id: 'ym2151',
            op: 'remove',
            reason: 'Seeded removal.',
          },
        ]),
      ),
    );
    expect(applyCorrections(db).removed).toBe(1);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM machine_chip WHERE mame_tag = 'ym2151'").get(),
    ).toEqual({ n: 0 });
    db.close();
  });

  it("op='add' inserts one, defaulting quantity to 1", () => {
    const db = loaded(
      dataset(
        corrections([
          {
            machine_id: 'shinobi',
            mame_tag: 'extra',
            chip_id: 'z80',
            op: 'add',
            reason: 'Seeded addition.',
          },
        ]),
      ),
    );
    expect(applyCorrections(db).added).toBe(1);
    expect(db.prepare("SELECT quantity FROM machine_chip WHERE mame_tag = 'extra'").get()).toEqual({
      quantity: 1,
    });
    db.close();
  });

  it("op='set' updates the value columns and leaves the key columns alone", () => {
    const db = loaded(
      dataset(
        corrections([
          {
            machine_id: 'shinobi',
            mame_tag: 'maincpu',
            chip_id: 'm68000',
            op: 'set',
            clock_hz: 12000000,
            reason: 'Seeded clock fix.',
          },
        ]),
      ),
    );
    expect(applyCorrections(db).set).toBe(1);
    expect(
      db.prepare("SELECT clock_hz FROM machine_chip WHERE mame_tag = 'maincpu'").get(),
    ).toEqual({ clock_hz: 12000000 });
    db.close();
  });

  it('machine_correction and machine_system need no pass — the views apply them', () => {
    const db = loaded(
      dataset(
        bundle('fixture://machine-correction.json', {
          machine_correction: [
            { machine_id: 'shinobi', name: 'Shinobi (corrected)', reason: 'Seeded.' },
          ],
          machine_system: [{ machine_id: 'shinobi', system_id: 'sega-system16a' }],
        }),
      ),
    );
    // The pass touches nothing, because it is only about machine_chip.
    expect(applyCorrections(db)).toEqual({ removed: 0, added: 0, set: 0 });
    // The base table is still MAME's word…
    expect(db.prepare("SELECT name FROM machine WHERE machine_id = 'shinobi'").get()).toEqual({
      name: 'Shinobi (set 6, System 16A)',
    });
    // …and the view is the corrected one.
    expect(db.prepare("SELECT name FROM v_machine WHERE machine_id = 'shinobi'").get()).toEqual({
      name: 'Shinobi (corrected)',
    });
    db.close();
  });

  it('the corrected BOM is what the headline metric counts (§5.2)', () => {
    const before = loaded(dataset());
    const baseline = before.prepare('SELECT mapped_instances FROM v_quality_instance').get();
    before.close();

    const after = loaded(
      dataset(
        corrections([
          {
            machine_id: 'shinobi',
            mame_tag: 'extra',
            chip_id: 'z80',
            op: 'add',
            quantity: 2,
            reason: 'Seeded addition.',
          },
        ]),
      ),
    );
    applyCorrections(after);
    expect(after.prepare('SELECT mapped_instances FROM v_quality_instance').get()).toEqual({
      mapped_instances: Number(baseline?.['mapped_instances']) + 2,
    });
    after.close();
  });
});

// ---------------------------------------------------------------------------
// §8 — the quality report
// ---------------------------------------------------------------------------

describe('data-quality.md §8 — the quality report', () => {
  it('every scalar equals the view it comes from', () => {
    const { result } = build(dataset());
    const db = openReadOnly(result.databasePath);
    expect(db.prepare('SELECT * FROM v_quality_device').get()).toEqual({
      devices_ignored: result.report.devices.ignored,
      devices_mapped: result.report.devices.mapped,
      devices_unmapped: result.report.devices.unmapped,
    });
    const instances = db
      .prepare(
        `SELECT mapped_instances, unmapped_instances, total_instances,
                ROUND(mapped_instance_share, 4) AS share FROM v_quality_instance`,
      )
      .get();
    expect(result.report.instances).toEqual({
      mapped: instances?.['mapped_instances'],
      mapped_instance_share: instances?.['share'],
      total: instances?.['total_instances'],
      unmapped: instances?.['unmapped_instances'],
    });
    const warnings = db
      .prepare('SELECT code, COUNT(*) AS n FROM v_quality_warning GROUP BY code ORDER BY code')
      .all();
    expect(Object.entries(result.report.warnings_by_code)).toEqual(
      warnings.map((row) => [row['code'], row['n']]),
    );
    expect(result.report.counts.machine).toBe(
      db.prepare('SELECT COUNT(*) AS n FROM machine').get()?.['n'],
    );
    db.close();
  });

  it('records the on-disk size of the file it describes', () => {
    const { result } = build(dataset());
    expect(result.report.db_bytes).toBe(result.size.rawBytes);
    expect(result.report.db_bytes).toBe(readFileSync(result.databasePath).length);
  });

  it('omits codes with no rows rather than writing zeros', () => {
    const { result } = build(dataset());
    for (const count of Object.values(result.report.warnings_by_code)) {
      expect(count).toBeGreaterThan(0);
    }
  });

  it('is written with bytewise-ascending keys, two-space indent and one trailing newline', () => {
    const { result } = build(dataset());
    const text = readFileSync(result.reportPath, 'utf8');
    expect(text).toBe(formatQualityReport(result.report));
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    expect(text).toContain('\n  "counts": {');
    expect(JSON.parse(text)).toEqual(result.report);
  });

  it('refuses to be written when it does not validate against its schema', () => {
    const schemasDir = scratch();
    const document = JSON.parse(
      readFileSync(join(SCHEMAS_DIR, 'quality-report.schema.json'), 'utf8'),
    ) as { properties: Record<string, Record<string, unknown>> };
    // A ceiling the real number cannot satisfy: proof that the report really is checked
    // against the schema before it is written, not after.
    document.properties['db_bytes'] = { type: 'integer', maximum: 0 };
    writeFileSync(join(schemasDir, 'quality-report.schema.json'), JSON.stringify(document));
    writeFileSync(
      join(schemasDir, 'common.schema.json'),
      readFileSync(join(SCHEMAS_DIR, 'common.schema.json')),
    );
    const messages = failure(dataset(), { schemasDir });
    expect(messages.join('\n')).toContain('quality-report.schema.json');
  });

  it('rejects a report whose keys are not bytewise ascending', () => {
    const { result } = build(dataset());
    const scrambled = { db_bytes: result.report.db_bytes, counts: result.report.counts };
    expect(() => formatQualityReport(scrambled as never)).toThrow(/bytewise ascending/);
  });

  it('validates a directly collected report against the shipped schema', () => {
    const db = loaded(dataset());
    for (const [key, value] of [
      ['dataset_version', BUILD_DATE],
      ['schema_version', '2.0.0'],
      ['threshold_version', '2.0.0'],
    ] as const) {
      db.prepare('INSERT OR REPLACE INTO dataset_meta (key, value) VALUES (?, ?)').run(key, value);
    }
    const report = collectQualityReport(db, 1024);
    db.close();
    expect(validateQualityReport(report)).toEqual([]);
  });
});

function shippedRegistryDrift(): string[] {
  const db = createSchemaDatabase();
  try {
    return reportRegistryDrift(db, SCHEMAS_DIR);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// The closed warning-code registry, stated twice
// ---------------------------------------------------------------------------

describe('the warning-code registry is discovered, not maintained twice', () => {
  it('reads every code out of the shipped view', () => {
    const db = createSchemaDatabase();
    const codes = warningCodeRegistry(db);
    db.close();
    // data-quality.md §4's registry, which the view is the executable copy of.
    expect(codes).toEqual([
      'CHIP_MANUFACTURER_FAMILY_MISMATCH',
      'CHIP_MISSING_METADATA',
      'CHIP_NAME_COLLISION',
      'EQUIVALENCE_MUTUAL_PROVIDES',
      'IMPL_MACHINES_WITHOUT_SYSTEM',
      'IMPL_STALE_REVIEW',
      'IMPL_UNTARGETED',
      'IMPL_UNVERIFIED_ACCURACY',
      'IMPL_UNVERIFIED_LICENSE',
      'MACHINE_ZERO_MAPPED_CHIPS',
      'MAPPED_INSTANCE_SHARE_LOW',
      'SYSTEM_NAME_COLLISION',
      'SYSTEM_NO_CHIPS',
      'SYSTEM_UNMAPPED_SHARE_HIGH',
      'UNMAPPED_DEVICE_HIGH_IMPACT',
    ]);
  });

  it('reports a code the view emits that the report schema forbids', () => {
    const schemasDir = scratch();
    const document = JSON.parse(
      readFileSync(join(SCHEMAS_DIR, 'quality-report.schema.json'), 'utf8'),
    ) as { properties: Record<string, { propertyNames: { enum: string[] } }> };
    const codes = document.properties['warnings_by_code']?.propertyNames.enum ?? [];
    document.properties['warnings_by_code'] = {
      propertyNames: { enum: codes.filter((code) => code !== 'SYSTEM_NO_CHIPS') },
    };
    writeFileSync(join(schemasDir, 'quality-report.schema.json'), JSON.stringify(document));
    const db = createSchemaDatabase();
    const drift = reportRegistryDrift(db, schemasDir);
    db.close();
    expect(drift.join('\n')).toContain('SYSTEM_NO_CHIPS');
  });

  it('reports a code the report schema enumerates that the view cannot emit', () => {
    const schemasDir = scratch();
    const document = JSON.parse(
      readFileSync(join(SCHEMAS_DIR, 'quality-report.schema.json'), 'utf8'),
    ) as { properties: Record<string, { propertyNames: { enum: string[] } }> };
    const codes = document.properties['warnings_by_code']?.propertyNames.enum ?? [];
    document.properties['warnings_by_code'] = {
      propertyNames: { enum: [...codes, 'INVENTED_CODE'] },
    };
    writeFileSync(join(schemasDir, 'quality-report.schema.json'), JSON.stringify(document));
    const db = createSchemaDatabase();
    const drift = reportRegistryDrift(db, schemasDir);
    db.close();
    expect(drift.join('\n')).toContain('INVENTED_CODE');
  });

  it('the shipped schema and the shipped view state the same closed registry', () => {
    // A failure here is a defect in schemas/quality-report.schema.json, not in this test.
    // `v_quality_warning` and data-quality.md §4 are the registry; the JSON Schema is a
    // third copy of it, and this is the mechanical check that keeps it honest — the same
    // guarantee `diffRowSchemas` gives the row schemas, from the same place, the tests.
    expect(shippedRegistryDrift()).toEqual([]);
  });

  it('every code the report schema enumerates is one the registry knows', () => {
    const db = createSchemaDatabase();
    const registry = warningCodeRegistry(db);
    db.close();
    expect(reportSchemaCodes().filter((code) => !registry.includes(code))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The size budget, at both of its levels
// ---------------------------------------------------------------------------

describe('the size budget reconciles two normative numbers', () => {
  it('takes the hard ceiling from the threshold table, not from a literal', () => {
    const db = createSchemaDatabase();
    loadThresholds(db, THRESHOLDS);
    expect(databaseSizeLimit(db)).toBe(THRESHOLDS['db_max_bytes']);
    db.close();
  });

  it("takes ADR 0001's revisit trigger from config/build.json", () => {
    const config = loadBuildConfig();
    // 32 MiB raw / 8 MiB brotli — two-thirds of the ceiling, and the transfer size.
    expect(config.revisitTrigger.rawBytes).toBe(32 * 1024 * 1024);
    expect(config.revisitTrigger.brotliBytes).toBe(8 * 1024 * 1024);
    expect(config.revisitTrigger.rawBytes).toBeLessThan(Number(THRESHOLDS['db_max_bytes']));
  });

  it('warns at the trigger and fails only at the ceiling', () => {
    const { result } = build(dataset(), {
      thresholds: { ...THRESHOLDS, db_max_bytes: 50331648 },
    });
    // The fixture is far under both, so neither fires.
    expect(result.size.failures).toEqual([]);
    expect(result.size.warnings).toEqual([]);
    expect(result.size.brotliBytes).toBeLessThan(result.size.rawBytes);
  });

  it('measures brotli at the quality ADR 0001 measured its trigger with', () => {
    const bytes = Buffer.from('bomsquad'.repeat(4096), 'utf8');
    expect(brotliSize(bytes)).toBeLessThan(bytes.length);
  });
});
