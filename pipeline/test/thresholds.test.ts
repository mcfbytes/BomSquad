/**
 * Quality thresholds: the typed table and the loader that fills it.
 *
 * A quality gate that disables itself when its config rots is worse than no gate, so
 * these tests are mostly about the failure modes the untyped `dataset_meta` version had:
 * a value that no longer parses, and a row that is simply absent.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createSchemaDatabase, readSchemaSql } from '../src/db/schema.js';
import { flattenThresholds, loadThresholds, requiredThresholds } from '../src/db/thresholds.js';

const CONFIG_PATH = join(import.meta.dirname, '..', 'config', 'quality-thresholds.json');

function config(): Record<string, unknown> {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Record<string, unknown>;
}

/** Drops one entry from an object without mutating it. */
function omit(source: Readonly<Record<string, unknown>>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(source).filter(([name]) => name !== key));
}

/** The shipped config minus one dotted key, for the "a gate must not go quiet" tests. */
function without(name: string): Record<string, unknown> {
  const parsed = config();
  const [head, ...rest] = name.split('.');
  if (head === undefined) return parsed;
  if (rest.length === 0) return omit(parsed, head);
  return { ...parsed, [head]: omit(parsed[head] as Record<string, unknown>, rest.join('.')) };
}

describe('the required threshold set is read out of the DDL, not maintained beside it', () => {
  it('is exactly the names the shipped views consult', () => {
    expect(requiredThresholds()).toEqual([
      'issue_generator.min_instance_count',
      'issue_generator.min_machine_count',
      'mapped_instance_share.warn_below',
      'stale_review_days',
      'system_unmapped_share.warn_above',
    ]);
  });

  it('grows with the view SQL rather than with a hand-edited list', () => {
    const invented = readSchemaSql().replace(
      "WHERE name = 'stale_review_days'",
      "WHERE name = 'invented.threshold'",
    );
    expect(requiredThresholds(invented)).toContain('invented.threshold');
    expect(requiredThresholds(invented)).not.toContain('stale_review_days');
  });
});

describe('flattening the config', () => {
  it('turns nested objects into dotted names and drops the non-numeric version', () => {
    expect(flattenThresholds(config())).toEqual([
      { name: 'db_max_bytes', value: 50331648 },
      { name: 'issue_generator.min_instance_count', value: 50 },
      { name: 'issue_generator.min_machine_count', value: 5 },
      { name: 'issue_generator.top_n', value: 25 },
      { name: 'mapped_instance_share.target', value: 0.9 },
      { name: 'mapped_instance_share.warn_below', value: 0.7 },
      { name: 'stale_review_days', value: 365 },
      { name: 'system_unmapped_share.warn_above', value: 0.25 },
    ]);
  });
});

describe('loading thresholds', () => {
  it('writes every numeric leaf as a typed row', () => {
    const db = createSchemaDatabase();
    loadThresholds(db, config());
    expect(
      db.prepare("SELECT value FROM threshold WHERE name = 'stale_review_days'").get(),
    ).toEqual({ value: 365 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM threshold').get()).toEqual({ n: 8 });
    db.close();
  });

  it('fails loudly when a threshold a view reads is missing', () => {
    const db = createSchemaDatabase();
    expect(() => {
      loadThresholds(db, without('stale_review_days'));
    }).toThrow(/missing from pipeline\/config\/quality-thresholds\.json: stale_review_days/);
    db.close();
  });

  it('fails loudly for a nested threshold too, naming every missing one', () => {
    const db = createSchemaDatabase();
    expect(() => {
      loadThresholds(db, without('issue_generator.min_machine_count'));
    }).toThrow(/issue_generator\.min_machine_count/);
    db.close();
  });

  it('refuses a malformed value at the column rather than CASTing it to 0.0', () => {
    const db = createSchemaDatabase();
    // The reproduced defect: `threshold.mapped_instance_share.warn_below = 'seventy'`
    // used to store fine in dataset_meta, CAST to 0.0, and silently stop the
    // MAPPED_INSTANCE_SHARE_LOW gate from ever firing again.
    expect(() => {
      db.exec(`INSERT INTO threshold VALUES ('mapped_instance_share.warn_below', 'seventy')`);
    }).toThrow(/cannot store TEXT value in REAL column/);
    // …and a config that omits it never reaches the views at all.
    expect(() => {
      loadThresholds(db, without('mapped_instance_share.warn_below'));
    }).toThrow(/mapped_instance_share\.warn_below/);
    db.close();
  });

  it('leaves the gate armed once loaded, which a NULL comparison never was', () => {
    const db = createSchemaDatabase();
    loadThresholds(db, config());
    db.exec(`
      INSERT INTO chip_function VALUES ('cpu', 'CPU', 'Executes an instruction stream.', 'medium');
      INSERT INTO chip (chip_id, display_name, function_id, description, manufacturer_id)
      VALUES ('z80', 'Z80', 'cpu', 'An 8-bit CPU.', NULL);
      INSERT INTO machine (machine_id, name, mame_sourcefile, is_bios, is_device, is_mechanical)
      VALUES ('shinobi', 'Shinobi', 'sega/system16a.cpp', 0, 0, 0);
      INSERT INTO machine_chip (machine_id, mame_tag, chip_id) VALUES ('shinobi', 'maincpu', 'z80');
      INSERT INTO machine_unmapped_device VALUES ('shinobi', 'sega_315_5195', 9);
    `);
    // 1 mapped instance against 9 unmapped is a share of 0.1, well under warn_below 0.7.
    expect(
      db
        .prepare(`SELECT impact FROM v_quality_warning WHERE code = 'MAPPED_INSTANCE_SHARE_LOW'`)
        .all(),
    ).toEqual([{ impact: 0.1 }]);
    db.close();
  });
});
