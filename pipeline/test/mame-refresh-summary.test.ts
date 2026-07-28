/**
 * TASKS T2.6 — the monthly MAME refresh workflow.
 *
 * The workflow itself cannot be dispatched from a test, so what is proved here is the
 * whole of its acceptance bar in testable form: given an old and a new extraction
 * snapshot, `buildRefreshSummary` computes the right diff and
 * `formatRefreshSummaryMarkdown` renders it into the exact PR body a curator would read.
 * `.github/workflows/mame-refresh.yml` is a thin caller around both — see
 * `pipeline/src/cli.ts`'s `mame:refresh-summary` command.
 */
import { describe, expect, it } from 'vitest';

import type { RawMachine } from '../src/mame/parse.js';
import type { WorklistEntry } from '../src/mame/worklist.js';
import {
  buildRefreshSummary,
  formatRefreshSummaryMarkdown,
  type RefreshSummaryInput,
} from '../src/mame/refresh-summary.js';

function machine(id: string, name: string): RawMachine {
  return {
    machine_id: id,
    name,
    mame_sourcefile: 'test/driver.cpp',
    is_bios: 0,
    is_device: 0,
    is_mechanical: 0,
    runnable: 1,
    devices: [],
  };
}

function device(mameDevice: string, instanceCount: number, machineCount: number): WorklistEntry {
  return {
    mame_device: mameDevice,
    instance_count: instanceCount,
    machine_count: machineCount,
    sample_machine_ids: [],
  };
}

const BASE: RefreshSummaryInput = {
  oldVersion: '0.288',
  newVersion: '0.289',
  oldMachines: [machine('alpha', 'Alpha'), machine('beta', 'Beta'), machine('gamma', 'Gamma')],
  newMachines: [machine('alpha', 'Alpha'), machine('gamma', 'Gamma'), machine('delta', 'Delta')],
  oldDevices: [device('z80', 10, 3), device('speaker', 5, 3)],
  newDevices: [device('z80', 12, 3), device('speaker', 5, 3), device('newchip', 3, 1)],
};

describe('buildRefreshSummary', () => {
  it('finds machines present only in the new extract', () => {
    expect(buildRefreshSummary(BASE).machinesAdded).toEqual([
      { machineId: 'delta', name: 'Delta' },
    ]);
  });

  it('finds machines present only in the old extract', () => {
    expect(buildRefreshSummary(BASE).machinesRemoved).toEqual([
      { machineId: 'beta', name: 'Beta' },
    ]);
  });

  it('carries the machine counts before and after, independent of the delta lists', () => {
    const summary = buildRefreshSummary(BASE);
    expect(summary.machineCountBefore).toBe(3);
    expect(summary.machineCountAfter).toBe(3);
  });

  it('finds a device name new to the release and reports its impact, ranked', () => {
    expect(buildRefreshSummary(BASE).newUnmappedDevices).toEqual([
      { mameDevice: 'newchip', instanceCount: 3, machineCount: 1 },
    ]);
  });

  it('never reports a device that existed before, however much its impact grew', () => {
    // z80 climbed from 10 to 12 instances but is not new — it is not this task's job to
    // say whether it is mapped, only whether it is new, and it is not.
    const summary = buildRefreshSummary(BASE);
    expect(summary.newUnmappedDevices.some((d) => d.mameDevice === 'z80')).toBe(false);
  });

  it('is empty across the board for two identical extracts, not a special case', () => {
    const input: RefreshSummaryInput = {
      ...BASE,
      newMachines: BASE.oldMachines,
      newDevices: BASE.oldDevices,
    };
    const summary = buildRefreshSummary(input);
    expect(summary.machinesAdded).toEqual([]);
    expect(summary.machinesRemoved).toEqual([]);
    expect(summary.newUnmappedDevices).toEqual([]);
  });

  it('ranks several new devices by instance count, breaking ties bytewise (worklist.ts’s order)', () => {
    const input: RefreshSummaryInput = {
      ...BASE,
      newDevices: [
        ...BASE.oldDevices,
        device('zzz_low', 2, 1),
        device('aaa_tie', 5, 2),
        device('bbb_tie', 5, 1),
        device('high_impact', 40, 6),
      ],
    };
    expect(buildRefreshSummary(input).newUnmappedDevices.map((d) => d.mameDevice)).toEqual([
      'high_impact',
      'aaa_tie',
      'bbb_tie',
      'zzz_low',
    ]);
  });

  it('sorts machine deltas bytewise regardless of input order', () => {
    const shuffled: RefreshSummaryInput = {
      ...BASE,
      newMachines: [
        machine('zeta', 'Zeta'),
        machine('alpha', 'Alpha'),
        machine('gamma', 'Gamma'),
        machine('delta', 'Delta'),
      ],
    };
    expect(buildRefreshSummary(shuffled).machinesAdded.map((m) => m.machineId)).toEqual([
      'delta',
      'zeta',
    ]);
  });
});

describe('formatRefreshSummaryMarkdown', () => {
  it('renders the exact PR body for the base fixture', () => {
    const summary = buildRefreshSummary(BASE);
    expect(formatRefreshSummaryMarkdown(summary)).toBe(
      [
        '## MAME refresh: 0.288 → 0.289',
        '',
        '**Machines:** 3 → 3 (+1 / -1)',
        '',
        '### Machines added (1)',
        '',
        '- `delta` — Delta',
        '',
        '### Machines removed (1)',
        '',
        '- `beta` — Beta',
        '',
        '### New unmapped devices, ranked by impact (1)',
        '',
        'Device short names that did not exist in the previous release and so cannot yet ' +
          'have a `mame_device` row — this is exactly how much the curation queue ' +
          '(`v_mame_device_worklist`) grew by this bump.',
        '',
        '| device | instances | machines |',
        '| --- | ---: | ---: |',
        '| `newchip` | 3 | 1 |',
        '',
      ].join('\n'),
    );
  });

  it('renders "None" for every section when nothing changed', () => {
    const summary = buildRefreshSummary({
      ...BASE,
      newMachines: BASE.oldMachines,
      newDevices: BASE.oldDevices,
    });
    const body = formatRefreshSummaryMarkdown(summary);
    expect(body).toContain('### Machines added (0)\n\n_None._');
    expect(body).toContain('### Machines removed (0)\n\n_None._');
    expect(body).toContain('### New unmapped devices, ranked by impact (0)');
    expect(body).toContain('_None._');
  });

  it('never uses locale-dependent number formatting, so the same summary is always the same bytes', () => {
    const big: RefreshSummaryInput = {
      ...BASE,
      newDevices: [...BASE.newDevices, device('million_impact', 1_234_567, 8_901)],
    };
    const body = formatRefreshSummaryMarkdown(buildRefreshSummary(big));
    expect(body).toContain('| `million_impact` | 1234567 | 8901 |');
    expect(body).not.toContain('1,234,567');
  });

  it('caps the machine and device lists and reports how many more there were', () => {
    const many: RefreshSummaryInput = {
      oldVersion: '0.288',
      newVersion: '0.289',
      oldMachines: [],
      newMachines: Array.from({ length: 5 }, (_, i) => machine(`m${i}`, `Machine ${i}`)),
      oldDevices: [],
      newDevices: Array.from({ length: 5 }, (_, i) => device(`d${i}`, 5 - i, 1)),
    };
    const body = formatRefreshSummaryMarkdown(buildRefreshSummary(many), {
      maxMachinesShown: 2,
      maxDevicesShown: 3,
    });
    expect(body).toContain('- _...and 3 more._');
    expect(body).toContain('_...and 2 more, by impact._');
  });

  it('is deterministic: formatting the same summary twice yields identical bytes', () => {
    const summary = buildRefreshSummary(BASE);
    expect(formatRefreshSummaryMarkdown(summary)).toBe(formatRefreshSummaryMarkdown(summary));
  });
});
