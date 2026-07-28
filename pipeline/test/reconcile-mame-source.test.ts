/**
 * TASKS T3.8 — the MAME driver `.cpp` witness, the one that finds what `-listxml` omits.
 *
 * The fixture below is a reduced `capcom/cps1.cpp`: a file header, a per-`ROM_START` Guru
 * note naming a custom chip, a `ROM_LOAD` whose *string literal* looks like a part number,
 * and a second board belonging to a different system through a `machine_system` override.
 * Between them they cover every decision this module makes, and the CPS-B-01 line is the
 * exact case TASKS T3.8 exists for: a part MAME models inside driver code, present in no
 * `machine_chip` row and no `machine_unmapped_device` row, and therefore invisible to every
 * coverage metric the dataset has.
 */
import { describe, expect, it } from 'vitest';

import { loadReconcileConfig } from '../src/reconcile/config.js';
import { buildChipIndex } from '../src/reconcile/parts.js';
import {
  attachRomStarts,
  driverUrls,
  extractComments,
  partsFromDriver,
} from '../src/reconcile/mame-source.js';

const recognition = loadReconcileConfig().recognition;
const index = buildChipIndex(
  [
    { chip_id: 'ym2151', display_name: 'YM2151' },
    { chip_id: 'm68000', display_name: 'MC68000' },
  ],
  [],
  recognition,
);

const DRIVER = [
  '// license:BSD-3-Clause',
  '/***************************************************************************',
  '',
  'Capcom System 1',
  '68000 for game, YM2151 for sound.',
  '',
  '***************************************************************************/',
  '',
  'void cps_state::cps1_map(address_map &map)',
  '{',
  '\tmap(0x800100, 0x80013f).w(FUNC(cps_state::cps1_cps_a_w));  /* CPS-A custom */',
  '}',
  '',
  '/* B-Board 88621B-2 */',
  '/*',
  '   Custom chip -   CAPCOM CPS-B-01 (QFP160)',
  '*/',
  'ROM_START( forgottn )',
  '\tROM_LOAD( "315-5197.1a", 0x0000, 0x0117, CRC(00000000) )',
  'ROM_END',
  '',
  '/*',
  '   Custom chip -   CAPCOM CPS-B-21 (QFP160)',
  '*/',
  'ROM_START( sf2ce )',
  'ROM_END',
].join('\n');

describe('extractComments', () => {
  it('keeps comment text and drops code', () => {
    const text = extractComments(DRIVER)
      .map((block) => block.text)
      .join('\n');
    expect(text).toContain('CPS-B-01');
    expect(text).toContain('CPS-A custom');
    expect(text).not.toContain('address_map');
  });

  it('never treats a comment marker inside a string literal as a comment', () => {
    const blocks = extractComments('const char *u = "http://example.invalid/x"; // real');
    expect(blocks.map((block) => block.text.trim())).toEqual(['real']);
  });

  it('reports the real line a block starts on, so a citation points at it', () => {
    const blocks = extractComments('code;\ncode;\n// here\n');
    expect(blocks[0]?.line).toBe(3);
  });

  it('keeps line arithmetic exact across a joined run of comments', () => {
    // Two adjacent line comments become one block; the second must still be line 2.
    const blocks = extractComments('// one\n// two\n');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.line).toBe(1);
    expect(blocks[0]?.text.split('\n')).toEqual([' one', ' two']);
  });
});

describe('attachRomStarts', () => {
  const attached = attachRomStarts(DRIVER, extractComments(DRIVER));

  it('attaches the block immediately above a ROM_START to that machine', () => {
    const guru = attached.find((block) => block.text.includes('CPS-B-01'));
    expect(guru?.machineId).toBe('forgottn');
  });

  it('leaves a file header unattached', () => {
    const header = attached.find((block) => block.text.includes('Capcom System 1'));
    expect(header?.machineId).toBeUndefined();
  });
});

describe('partsFromDriver', () => {
  const blob = 'https://github.com/mamedev/mame/blob/mame0288/src/mame/capcom/cps1.cpp';
  const parts = partsFromDriver(
    DRIVER,
    'capcom/cps1.cpp',
    blob,
    ['capcom-cps1'],
    new Map([
      ['forgottn', 'capcom-cps1'],
      ['sf2ce', 'capcom-cps1-5'],
    ]),
    recognition,
    index,
  );

  it('surfaces the custom chips MAME models in driver code and never as a device', () => {
    const cps1 = (parts.get('capcom-cps1') ?? []).map((part) => part.designation);
    expect(cps1).toContain('CPS-B-01');
    expect(cps1).toContain('CPS-A');
    expect(cps1).toContain('YM2151');
  });

  it('gives an uncatalogued custom a part: key rather than inventing a chip row', () => {
    const cpsb = (parts.get('capcom-cps1') ?? []).find((part) => part.designation === 'CPS-B-01');
    expect(cpsb?.key).toBe('part:CPSB01');
    expect(cpsb?.chip_id).toBeUndefined();
  });

  it('cites the exact line, so a curator can read the claim', () => {
    const cpsb = (parts.get('capcom-cps1') ?? []).find((part) => part.designation === 'CPS-B-01');
    expect(cpsb?.source_url).toBe(`${blob}#L16`);
    expect(DRIVER.split('\n')[15]).toContain('CPS-B-01');
  });

  it('routes a per-ROM_START note to the system that machine really belongs to', () => {
    // `sf2ce` is a CPS-1.5 board living in the CPS-1 driver via a machine_system override.
    const cps15 = (parts.get('capcom-cps1-5') ?? []).map((part) => part.designation);
    expect(cps15).toEqual(['CPS-B-21']);
    expect((parts.get('capcom-cps1') ?? []).map((p) => p.designation)).not.toContain('CPS-B-21');
  });

  it('ignores a part number that is only a ROM label', () => {
    // `"315-5197.1a"` is a PLD dump in a string literal, not a socket on the board.
    const all = [...parts.values()].flat().map((part) => part.designation);
    expect(all).not.toContain('315-5197');
  });

  it('drops a ROM_START whose machine is not in the extract', () => {
    const orphan = partsFromDriver(
      DRIVER,
      'capcom/cps1.cpp',
      blob,
      [],
      new Map(),
      recognition,
      index,
    );
    expect([...orphan.keys()]).toEqual([]);
  });
});

describe('driverUrls', () => {
  it('pins both URLs to the release the extraction already uses', () => {
    const urls = driverUrls('sega/segas16b.cpp', 'mame0288', {
      enabled: true,
      rawBaseUrl: 'https://raw.githubusercontent.com/mamedev/mame',
      blobBaseUrl: 'https://github.com/mamedev/mame/blob',
      sourceRoot: 'src/mame',
    });
    expect(urls.raw).toBe(
      'https://raw.githubusercontent.com/mamedev/mame/mame0288/src/mame/sega/segas16b.cpp',
    );
    expect(urls.blob).toBe(
      'https://github.com/mamedev/mame/blob/mame0288/src/mame/sega/segas16b.cpp',
    );
  });
});
