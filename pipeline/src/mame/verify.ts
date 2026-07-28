/**
 * Proves the extract can become rows — by making it rows.
 *
 * TASKS T2.2 asks the full run to "validate against the raw-machine schema". There is no
 * such JSON Schema in `schemas/`, and writing one here would create a second, weaker
 * statement of grammars the DDL already states exactly (data-model.md §3.2 grammars, all
 * of them expressed as `GLOB` conjunctions in `schemas/schema.sql`). So instead of
 * describing the shape, this module *executes* it: a throwaway in-memory database is built
 * from the real DDL and every extracted machine, every socket and every device is
 * inserted into `machine`, `machine_chip` and `machine_unmapped_device`.
 *
 * That makes the claim the extract exists to support — "these values are already rows,
 * T6.1 only has to route them" — checkable rather than asserted, and it is strictly
 * stronger than a schema comparison: `PRIMARY KEY`, `NOT NULL`, every `CHECK` grammar,
 * and `ux_machine_chip_tag` (two chips in one socket) all fire for real.
 *
 * Two details make it honest rather than circular:
 *
 * - Every device is inserted into **both** `machine_chip` and `machine_unmapped_device`,
 *   because T6.1 routes each device to one or the other depending on whether a curator has
 *   mapped it, and the extract has to be insertable either way.
 * - `machine_unmapped_device` is keyed `(machine_id, mame_device)`, so devices are grouped
 *   by short name with `quantity` as the instance count — which is exactly the grouping
 *   T6.1 must perform, executed here against the real unique constraint.
 *
 * Violations are **returned, not thrown**. A `CHECK` this extract cannot satisfy is a
 * disagreement between MAME's data and `schemas/schema.sql`, and the useful response is a
 * complete, counted list a maintainer can act on — not a pipeline that stops on the first
 * one and hides the other nine.
 */
import { createSchemaDatabase } from '../db/schema.js';
import { compareBytes } from '../db/rowfiles.js';
import type { RawMachine } from './parse.js';

/** One row the DDL refused, named down to the machine and the value. */
export interface SchemaViolation {
  readonly table: string;
  readonly machineId: string;
  readonly detail: string;
}

/** A stand-in `chip` row, so `machine_chip.chip_id`'s foreign key has something to point at. */
const PROBE_CHIP = 'probe';

/**
 * SQLite reproduces the whole failing `CHECK` expression, which for the grammar columns is
 * five lines of `GLOB` conjunction. Collapsed to one line the diagnostics stay greppable
 * and a run log with twenty of them is still readable.
 */
function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim();
}

/**
 * Inserts the whole extract into a fresh schema database and returns every rejection.
 *
 * `limitPerTable` caps how many violations are *detailed* per table; `counts` is exact
 * either way. The cap keeps a systemic failure — every machine refused for one reason —
 * from producing a hundred megabytes of identical diagnostics, and the caller treats an
 * uncapped-away violation as unexpected, so capping can only ever fail the build harder.
 */
export function verifyAgainstSchema(
  machines: readonly RawMachine[],
  limitPerTable = 1000,
): {
  readonly violations: readonly SchemaViolation[];
  readonly counts: ReadonlyMap<string, number>;
} {
  const db = createSchemaDatabase();
  const violations: SchemaViolation[] = [];
  const counts = new Map<string, number>();

  const record = (table: string, machineId: string, detail: string): void => {
    counts.set(table, (counts.get(table) ?? 0) + 1);
    if ((counts.get(table) ?? 0) <= limitPerTable) violations.push({ table, machineId, detail });
  };

  try {
    db.exec(
      `INSERT INTO chip_function VALUES ('cpu', 'CPU', 'Executes an instruction stream.', 'medium');
       INSERT INTO chip (chip_id, display_name, function_id)
       VALUES ('${PROBE_CHIP}', 'Verification probe', 'cpu');`,
    );
    const insertMachine = db.prepare(
      `INSERT INTO machine (machine_id, name, mame_sourcefile, mame_year, mame_manufacturer,
                            clone_count, driver_status, is_bios, is_device, is_mechanical)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertChip = db.prepare(
      'INSERT INTO machine_chip (machine_id, mame_tag, chip_id, clock_hz) VALUES (?, ?, ?, ?)',
    );
    const insertUnmapped = db.prepare(
      'INSERT INTO machine_unmapped_device (machine_id, mame_device, quantity) VALUES (?, ?, ?)',
    );

    db.exec('BEGIN');
    for (const machine of machines) {
      let inserted = true;
      try {
        insertMachine.run(
          machine.machine_id,
          machine.name,
          machine.mame_sourcefile,
          machine.mame_year ?? null,
          machine.mame_manufacturer ?? null,
          machine.clone_count ?? null,
          machine.driver_status ?? null,
          machine.is_bios,
          machine.is_device,
          machine.is_mechanical,
        );
      } catch (error) {
        inserted = false;
        // The constraint text names the column; the row is reproduced so the offending
        // *value* is in the log too, without a second run to go and look it up.
        const row = JSON.stringify({ ...machine, devices: machine.devices.length });
        record('machine', machine.machine_id, `${message(error)} — row ${row}`);
      }
      // Child rows can only be tried when the parent exists; the foreign key would
      // otherwise report a failure that says nothing about the child's own values.
      if (!inserted) continue;

      for (const device of machine.devices) {
        try {
          insertChip.run(machine.machine_id, device.mame_tag, PROBE_CHIP, device.clock_hz ?? null);
        } catch (error) {
          record('machine_chip', machine.machine_id, `${device.mame_tag}: ${message(error)}`);
        }
      }

      const quantities = new Map<string, number>();
      for (const device of machine.devices) {
        quantities.set(device.mame_device, (quantities.get(device.mame_device) ?? 0) + 1);
      }
      for (const [mameDevice, quantity] of [...quantities].sort((a, b) =>
        compareBytes(a[0], b[0]),
      )) {
        try {
          insertUnmapped.run(machine.machine_id, mameDevice, quantity);
        } catch (error) {
          record('machine_unmapped_device', machine.machine_id, `${mameDevice}: ${message(error)}`);
        }
      }
    }
    db.exec('COMMIT');
  } finally {
    db.close();
  }

  return {
    violations: violations.sort(
      (a, b) => compareBytes(a.table, b.table) || compareBytes(a.machineId, b.machineId),
    ),
    counts: new Map([...counts].sort((a, b) => compareBytes(a[0], b[0]))),
  };
}
