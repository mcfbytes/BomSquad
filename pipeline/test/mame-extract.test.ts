/**
 * Golden fixtures and determinism for the MAME extraction (TASKS T2.5).
 *
 * ## How the fixture is built to catch an unsorted iteration
 *
 * TASKS T2.5's acceptance bar is that "deliberately introducing an unsorted map iteration
 * makes it fail". Running the extraction twice cannot show that: `Map` and `Set` iterate
 * in insertion order, insertion order is a function of the input document, and the input
 * document does not change between two runs — so an implementation that leaks insertion
 * order into an output is perfectly reproducible and perfectly wrong.
 *
 * What catches it is a **golden file over input whose document order is not its output
 * order**, and `fixtures/mame/listxml.xml` is built to be exactly that:
 *
 * - machines appear out of bytewise sequence (`zeta` first, `alpha` fourth), so emitting
 *   in parse order changes the machine array;
 * - `<device_ref>`s appear out of tag sequence within a machine, so emitting devices in
 *   parse order changes every machine record;
 * - two clones **precede** their parent, so a `clone_count` accumulated in one pass
 *   undercounts;
 * - `m68000`, `speaker` and `z80` all have an instance count of 3, so the worklist's
 *   bytewise tiebreak decides three positions rather than none;
 * - `pokey` carries two `<chip type>` values whose document order (`cpu` then `audio`) is
 *   the reverse of their sorted order.
 *
 * The comparison is against **bytes on disk**, produced by the same writer the real run
 * uses, so this covers the emitter's key order and formatting as well as the sorts.
 *
 * ## What this file does not do
 *
 * It never touches the network and never reads the 309 MB archive. `runExtraction` is I/O
 * assembly over the pure functions exercised here; the end-to-end proof that it agrees is
 * the CI job, which regenerates `extract/` and diffs it against what is committed.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadExtractConfig, type ExtractConfig } from '../src/mame/config.js';
import { parseMachinesFromString, type RawMachine } from '../src/mame/parse.js';
import { applyFilter, decide, DROP_REASONS, matchesSourcefile } from '../src/mame/filter.js';
import { buildWorklist } from '../src/mame/worklist.js';
import { writeRecordArrayFile } from '../src/mame/json.js';
import { verifyAgainstSchema } from '../src/mame/verify.js';
import { classifyViolations } from '../src/mame/extract.js';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'mame');
const config: ExtractConfig = loadExtractConfig(join(FIXTURES, 'mame-extract.json'));

const dir = mkdtempSync(join(tmpdir(), 'bomsquad-mame-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Header the golden files were generated with. No timestamp: it would not be reproducible. */
const HEADER = {
  mame_release: 'mame0288',
  mame_version: '0.288',
  mame_build: '0.288 (mame0288)',
  listxml_sha256: 'fixture',
  extract_config_version: config.version,
} as const;

function parseFixture(): { readonly machines: RawMachine[]; readonly build: string } {
  const machines: RawMachine[] = [];
  const stats = parseMachinesFromString(
    readFileSync(join(FIXTURES, 'listxml.xml'), 'utf8'),
    (machine) => machines.push(machine),
  );
  return { machines, build: stats.build };
}

/** Runs filter + worklist + emitter over `machines` and returns the two files' bytes. */
function emit(
  machines: readonly RawMachine[],
  name: string,
): { machines: string; devices: string } {
  const filtered = applyFilter(config.filter, machines);
  const worklist = buildWorklist(filtered.machines, config.worklist.sampleMachineIds);
  const machinesPath = join(dir, `${name}-machines.json`);
  const devicesPath = join(dir, `${name}-devices.json`);
  writeRecordArrayFile(
    machinesPath,
    { ...HEADER, machine_count: filtered.machines.length },
    'machines',
    filtered.machines,
  );
  writeRecordArrayFile(
    devicesPath,
    { ...HEADER, device_count: worklist.length },
    'devices',
    worklist,
  );
  return {
    machines: readFileSync(machinesPath, 'utf8'),
    devices: readFileSync(devicesPath, 'utf8'),
  };
}

describe('the parser', () => {
  const { machines, build } = parseFixture();
  const byId = new Map(machines.map((machine) => [machine.machine_id, machine]));

  it('reads the document build string', () => {
    expect(build).toBe('0.288 (mame0288)');
  });

  it('parses every machine, including devices and clones', () => {
    expect(machines).toHaveLength(10);
  });

  it('shapes MAME booleans as the 0/1 integers the machine table declares', () => {
    expect(byId.get('devchip')).toMatchObject({ is_device: 1, runnable: 0 });
    expect(byId.get('biosset')).toMatchObject({ is_bios: 1, is_device: 0, is_mechanical: 0 });
    expect(byId.get('mech')).toMatchObject({ is_mechanical: 1 });
    // The DTD defaults runnable to "yes"; MAME writes the attribute only to say "no".
    expect(byId.get('zeta')?.runnable).toBe(1);
  });

  it('decodes entity and character references in text', () => {
    expect(byId.get('alpha')?.name).toBe('Alpha & Omega (<prototype>, AB)');
    expect(byId.get('zeta')?.name).toBe(`Zeta & Sons (rev "B", it's fine)`);
  });

  it('treats CDATA as literal', () => {
    expect(byId.get('alpha')?.mame_manufacturer).toBe('Taito & Co');
  });

  it('keeps year verbatim, however unusable it is as a number', () => {
    expect(byId.get('alpha')?.mame_year).toBe('19??');
  });

  it('omits an absent value rather than writing null', () => {
    expect(byId.get('devchip')).not.toHaveProperty('mame_year');
    expect(byId.get('devchip')).not.toHaveProperty('driver_status');
    expect(byId.get('zeta')).not.toHaveProperty('cloneof');
  });

  it('strips the leading colon from a device_ref tag so it is machine_chip.mame_tag', () => {
    expect(byId.get('zeta')?.devices.map((device) => device.mame_tag)).toEqual([
      'audiocpu',
      'maincpu',
      'speaker',
      'ym2151',
    ]);
  });

  it('joins <chip> to <device_ref> on the tag, giving each socket a short name and a clock', () => {
    expect(byId.get('zeta')?.devices[1]).toEqual({
      mame_tag: 'maincpu',
      mame_device: 'm68000',
      chip_types: ['cpu'],
      chip_name: 'Motorola MC68000',
      clock_hz: 10000000,
    });
  });

  it('folds a part MAME lists as both cpu and audio into one socket with two types', () => {
    // Two <chip> elements, one tag: one chip with two roles, not two chips in one socket
    // — which is what ux_machine_chip_tag would refuse.
    expect(byId.get('alpha')?.devices.find((device) => device.mame_tag === 'pokey')).toEqual({
      mame_tag: 'pokey',
      mame_device: 'pokey',
      chip_types: ['audio', 'cpu'],
      chip_name: 'Atari C012294 POKEY',
      clock_hz: 1789790,
    });
  });

  it('omits clock="0", which machine_chip.clock_hz could not store anyway', () => {
    const maincpu = byId.get('alpha')?.devices.find((device) => device.mame_tag === 'maincpu');
    expect(maincpu).not.toHaveProperty('clock_hz');
    expect(maincpu?.chip_name).toBe('Motorola MC68000');
  });

  it('counts a <chip> with no <device_ref> instead of inventing a short name for it', () => {
    // 'devchip' declares <chip tag="ym"> and no <device_ref>: there is no key to record it
    // under, so it is dropped and counted.
    const stats = parseMachinesFromString(
      readFileSync(join(FIXTURES, 'listxml.xml'), 'utf8'),
      () => undefined,
    );
    expect(stats.chipsWithoutDeviceRef).toBe(1);
    expect(byId.get('devchip')?.devices).toEqual([]);
  });
});

describe('the filter', () => {
  const { machines } = parseFixture();
  const result = applyFilter(config.filter, machines);

  it('matches an exact driver path and a directory prefix, and nothing else', () => {
    expect(matchesSourcefile('misc/goldnpkr.cpp', 'misc/goldnpkr.cpp')).toBe(true);
    expect(matchesSourcefile('misc/goldnpkr.cpp', 'misc/goldnpkr2.cpp')).toBe(false);
    expect(matchesSourcefile('fruit/', 'fruit/fruity.cpp')).toBe(true);
    expect(matchesSourcefile('fruit/', 'fruitless/x.cpp')).toBe(false);
  });

  it('keeps exactly the machines that survive every rule', () => {
    expect(result.machines.map((machine) => machine.machine_id)).toEqual([
      'alpha',
      'biosset',
      'keepme',
      'zeta',
    ]);
  });

  it('accounts for every dropped machine, with the counts summing to the total', () => {
    expect([...result.stats.dropped]).toEqual([
      ['device', 1],
      ['mechanical', 1],
      ['clone', 2],
      ['bios', 0],
      ['excluded_driver', 2],
    ]);
    let total = result.stats.kept;
    for (const count of result.stats.dropped.values()) total += count;
    expect(total).toBe(result.stats.total);
    expect(result.stats.total).toBe(10);
  });

  it('gives a machine that qualifies for several reasons the first one in the fixed order', () => {
    // A device that is also mechanical, also a clone, also in an excluded driver.
    const everything: RawMachine = {
      machine_id: 'x',
      name: 'X',
      mame_sourcefile: 'fruit/fruity.cpp',
      is_bios: 1,
      is_device: 1,
      is_mechanical: 1,
      runnable: 0,
      cloneof: 'y',
      devices: [],
    };
    expect(decide(config.filter, everything)).toEqual({ kept: false, reason: 'device' });
    expect(decide({ ...config.filter, dropDevices: false }, everything)).toEqual({
      kept: false,
      reason: 'mechanical',
    });
    expect(DROP_REASONS[0]).toBe('device');
  });

  it('records clone_count on a parent whose clones appeared before it in the document', () => {
    expect(result.machines.find((machine) => machine.machine_id === 'alpha')?.clone_count).toBe(2);
  });

  it('omits clone_count entirely for a parent with no clones', () => {
    expect(result.machines.find((machine) => machine.machine_id === 'zeta')).not.toHaveProperty(
      'clone_count',
    );
  });

  it('lets a keep_sourcefile exception win over an excluded directory prefix', () => {
    expect(result.machines.map((machine) => machine.machine_id)).toContain('keepme');
    expect([...result.stats.excludedByRule]).toEqual([
      ['fruit/', 1],
      ['misc/goldnpkr.cpp', 1],
    ]);
    expect(result.stats.unusedExcludeRules).toEqual([]);
    expect(result.stats.unusedKeepRules).toEqual([]);
  });

  it('reports a rule that matched nothing, which is how a typo becomes visible', () => {
    const stats = applyFilter(
      {
        ...config.filter,
        excludeSourcefile: [
          ...config.filter.excludeSourcefile,
          { pattern: 'nosuch/driver.cpp', reason: 'typo' },
        ],
      },
      machines,
    ).stats;
    expect(stats.unusedExcludeRules).toEqual(['nosuch/driver.cpp']);
  });

  it('keeps BIOS sets by default, because a BIOS set is real hardware with a real BOM', () => {
    expect(result.machines.map((machine) => machine.machine_id)).toContain('biosset');
    const strict = applyFilter({ ...config.filter, dropBios: true }, machines);
    expect(strict.machines.map((machine) => machine.machine_id)).not.toContain('biosset');
    expect(strict.stats.dropped.get('bios')).toBe(1);
  });
});

describe('the device worklist', () => {
  const { machines } = parseFixture();
  const worklist = buildWorklist(
    applyFilter(config.filter, machines).machines,
    config.worklist.sampleMachineIds,
  );

  it('ranks by instance count, breaking ties bytewise on the device name', () => {
    expect(worklist.map((entry) => entry.mame_device)).toEqual([
      'm68000',
      'speaker',
      'z80',
      'pokey',
      'ym2151',
    ]);
  });

  it('distinguishes instances from machines', () => {
    // 'keepme' has two z80 sockets: three instances across two machines.
    expect(worklist.find((entry) => entry.mame_device === 'z80')).toMatchObject({
      instance_count: 3,
      machine_count: 2,
    });
  });

  it('bounds the machine sample and sorts it bytewise', () => {
    for (const entry of worklist) {
      expect(entry.sample_machine_ids.length).toBeLessThanOrEqual(config.worklist.sampleMachineIds);
      expect(entry.sample_machine_ids).toEqual([...entry.sample_machine_ids].sort());
    }
    expect(worklist[0]?.sample_machine_ids).toEqual(['alpha', 'biosset', 'zeta']);
  });

  it("carries MAME's own words for the part, so the list is usable without MAME's source", () => {
    expect(worklist.find((entry) => entry.mame_device === 'pokey')).toMatchObject({
      chip_types: ['audio', 'cpu'],
      chip_names: ['Atari C012294 POKEY'],
    });
  });

  it('has no chip_types for a device MAME never described with a <chip>', () => {
    // In the real extract these are screens, palettes and gfxdecodes: worklist entries
    // whose disposition is an ignore_reason, not a chip mapping.
    const worklistWithBus = buildWorklist(
      [
        {
          machine_id: 'a',
          name: 'A',
          mame_sourcefile: 'x/y.cpp',
          is_bios: 0,
          is_device: 0,
          is_mechanical: 0,
          runnable: 1,
          devices: [{ mame_tag: 'screen', mame_device: 'screen' }],
        },
      ],
      3,
    );
    expect(worklistWithBus[0]).not.toHaveProperty('chip_types');
    expect(worklistWithBus[0]).not.toHaveProperty('chip_names');
  });
});

describe('golden files', () => {
  const { machines } = parseFixture();

  it('reproduces extract/machines.raw.json byte for byte', () => {
    expect(emit(machines, 'golden').machines).toBe(
      readFileSync(join(FIXTURES, 'machines.expected.json'), 'utf8'),
    );
  });

  it('reproduces extract/mame-devices.raw.json byte for byte', () => {
    expect(emit(machines, 'golden').devices).toBe(
      readFileSync(join(FIXTURES, 'devices.expected.json'), 'utf8'),
    );
  });
});

describe('determinism', () => {
  const { machines } = parseFixture();

  it('produces identical bytes when run twice', () => {
    expect(emit(machines, 'first')).toEqual(emit(machines, 'second'));
  });

  it('produces identical bytes when the document order changes', () => {
    // The check a re-run cannot make. Map and Set iterate in insertion order, and two runs
    // over one document insert in the same order — so only a *different* document order
    // exposes an output that inherited it.
    const reversed = [...machines].reverse();
    expect(emit(reversed, 'reversed')).toEqual(emit(machines, 'forward'));
  });

  it('produces identical bytes under every rotation of the document order', () => {
    const baseline = emit(machines, 'rotate-base');
    for (let offset = 1; offset < machines.length; offset += 1) {
      const rotated = [...machines.slice(offset), ...machines.slice(0, offset)];
      expect(emit(rotated, `rotate-${offset}`), `rotation ${offset}`).toEqual(baseline);
    }
  });
});

describe('the extract is already rows', () => {
  const { machines } = parseFixture();
  const kept = applyFilter(config.filter, machines).machines;

  it('inserts into machine, machine_chip and machine_unmapped_device unchanged', () => {
    // The strongest available reading of "validates against the raw-machine schema": every
    // value is offered to the real DDL, so every CHECK grammar, NOT NULL and unique index
    // fires for real rather than against a second description of them.
    const { violations } = verifyAgainstSchema(kept);
    expect(violations).toEqual([]);
  });

  /** The first kept machine, as a base to mutate. Throws rather than silently testing nothing. */
  function base(): RawMachine {
    const machine = kept[0];
    if (machine === undefined) throw new Error('the fixture kept no machines');
    return machine;
  }

  it('catches a value the DDL would refuse', () => {
    // An uppercase letter in a driver path. A hyphen used to be the example here, but
    // schema.sql D12 admits '-' — MAME 0.288 ships 29 driver paths containing one and ten
    // kept machines use six of them, so the grammar was wrong, not the data. The alphabet
    // CHECK still refuses case, which is what this asserts.
    const { violations, counts } = verifyAgainstSchema([
      { ...base(), mame_sourcefile: 'sega/System16B.cpp' },
    ]);
    expect(counts.get('machine')).toBe(1);
    expect(violations[0]?.detail).toMatch(/CHECK constraint failed/);
  });

  it('catches two different chips claiming one socket', () => {
    const collision: RawMachine[] = [
      {
        ...base(),
        devices: [
          { mame_tag: 'maincpu', mame_device: 'z80' },
          { mame_tag: 'maincpu', mame_device: 'm68000' },
        ],
      },
    ];
    expect(verifyAgainstSchema(collision).counts.get('machine_chip')).toBe(1);
  });

  describe('acknowledging a refusal the DDL owns', () => {
    const refused = verifyAgainstSchema([
      { ...base(), machine_id: 'racingj', mame_sourcefile: 'konami/NWK.cpp' },
    ]);

    it('fails the run when nothing acknowledges it', () => {
      const verdict = classifyViolations(refused, []);
      expect(verdict.unexpected).toHaveLength(1);
      expect(verdict.known).toEqual([]);
    });

    it('passes the run when the config names it, and keeps reporting the reason', () => {
      const verdict = classifyViolations(refused, [
        { key: 'machine/racingj', reason: 'sourcefile contains an uppercase letter.' },
      ]);
      expect(verdict.unexpected).toEqual([]);
      expect(verdict.known[0]?.reason).toBe('sourcefile contains an uppercase letter.');
      expect(verdict.unusedKnown).toEqual([]);
    });

    it('is not a mute button: a different machine still fails', () => {
      const verdict = classifyViolations(refused, [
        { key: 'machine/somethingelse', reason: 'unrelated' },
      ]);
      expect(verdict.unexpected).toHaveLength(1);
      expect(verdict.unusedKnown).toEqual(['machine/somethingelse']);
    });

    it('reports an acknowledgement that stopped applying, so it can be deleted', () => {
      const clean = verifyAgainstSchema(kept);
      const verdict = classifyViolations(clean, [
        { key: 'machine/racingj', reason: 'fixed in the DDL' },
      ]);
      expect(verdict.unexpected).toEqual([]);
      expect(verdict.unusedKnown).toEqual(['machine/racingj']);
    });

    it('treats a refusal the detail cap swallowed as unexpected, never as acknowledged', () => {
      // Two refusals, one detailed: the undetailed one has no key to match and must fail.
      const two = verifyAgainstSchema(
        [
          { ...base(), machine_id: 'racingj', mame_sourcefile: 'konami/NWK.cpp' },
          { ...base(), machine_id: 'thrilld', mame_sourcefile: 'konami/NWK.cpp' },
        ],
        1,
      );
      expect(two.counts.get('machine')).toBe(2);
      const verdict = classifyViolations(two, [
        { key: 'machine/racingj', reason: 'known' },
        { key: 'machine/thrilld', reason: 'known' },
      ]);
      expect(verdict.unexpected).toHaveLength(1);
      expect(verdict.unexpected[0]?.table).toBe('(undetailed)');
    });
  });
});

describe('the shipped known_schema_violations list', () => {
  it('is empty: MAME 0.288 has no machine the DDL refuses', () => {
    // It briefly held ten machines, all of them one defect: the `sourcefile` grammar
    // forbade a hyphen, while MAME ships 29 driver paths containing one and ten kept
    // machines use six of those. That was a bug in the DDL, not in the data, and
    // schema.sql D12 fixed it — so the acknowledgements were deleted rather than kept.
    //
    // Empty is the state this list should stay in. It exists so that a *new* refusal, in
    // a future MAME release, fails the run loudly instead of being silently dropped; an
    // entry here is a deliberate, reasoned exception, and `unusedKnown` reporting means a
    // stale one cannot rot unnoticed.
    const shipped = loadExtractConfig(
      join(import.meta.dirname, '..', 'config', 'mame-extract.json'),
    );
    expect(shipped.knownSchemaViolations).toEqual([]);
  });
});
