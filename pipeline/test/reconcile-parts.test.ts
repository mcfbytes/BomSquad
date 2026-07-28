/**
 * TASKS T3.8 — part designations: normalising them, indexing the catalogue, and finding
 * them in free text.
 *
 * This is the layer that decides whether two witnesses are talking about the same silicon,
 * so it is proved against synthetic fixtures rather than against `data/chip/*.json`, which
 * is under active curation and grows daily. The one exception is the real configuration:
 * `recognition` is policy the shipped file owns, and a test that invented its own vendor
 * prefixes and grammars would prove nothing about what `pipeline reconcile` actually does.
 */
import { describe, expect, it } from 'vitest';

import { loadReconcileConfig } from '../src/reconcile/config.js';
import {
  buildChipIndex,
  normalizePart,
  normalizeWithoutVendor,
  resolvePart,
  scanParts,
} from '../src/reconcile/parts.js';
import type { Row } from '../src/db/rowfiles.js';

const recognition = loadReconcileConfig().recognition;

const chips: readonly Row[] = [
  { chip_id: 'ym2151', display_name: 'YM2151' },
  { chip_id: 'm68000', display_name: 'MC68000' },
  { chip_id: 'z80', display_name: 'Z80' },
  { chip_id: 'upd7759', display_name: 'µPD7759' },
  { chip_id: 'ay8910', display_name: 'AY-3-8910' },
  { chip_id: 'sega-315-5296', display_name: 'Sega 315-5296' },
  { chip_id: 'sh7604', display_name: 'SH-2 (SH7604)' },
];
const chipNames: readonly Row[] = [{ chip_id: 'm68000', name: 'MC68000P10' }];
const index = buildChipIndex(chips, chipNames, recognition);

describe('normalisation', () => {
  it('folds the micro sign, because the two sources spell it differently', () => {
    // MAME's ASCII PCB diagrams write `uPD7759`; the chip catalogue writes `µPD7759`.
    expect(normalizePart('µPD7759')).toBe('UPD7759');
    expect(normalizePart('uPD7759')).toBe('UPD7759');
    expect(normalizePart('μPD7759')).toBe('UPD7759');
  });

  it('drops punctuation and case but nothing else', () => {
    expect(normalizePart('AY-3-8910')).toBe('AY38910');
    expect(normalizePart('315-5296')).toBe('3155296');
  });

  it('strips a leading manufacturer word so a catalogue id meets a bare part number', () => {
    expect(normalizeWithoutVendor('Sega 315-5296', recognition.vendorPrefixes)).toBe('3155296');
    expect(normalizeWithoutVendor('sega-315-5296', recognition.vendorPrefixes)).toBe('3155296');
    expect(normalizeWithoutVendor('315-5296', recognition.vendorPrefixes)).toBe('3155296');
  });

  it('never strips a prefix that is the whole designation', () => {
    // Otherwise a chip called `Sega` would key on the empty string and collide with
    // everything else that normalised away.
    expect(normalizeWithoutVendor('Sega', recognition.vendorPrefixes)).toBe('SEGA');
  });

  it('prefers the longest vendor prefix, so prefix order cannot change the answer', () => {
    expect(normalizeWithoutVendor('OKI M6295', recognition.vendorPrefixes)).toBe('M6295');
  });
});

describe('the catalogue index', () => {
  it('resolves a bare part number to the chip whose display name carries the vendor', () => {
    expect(resolvePart('315-5296', index, recognition)?.chipId).toBe('sega-315-5296');
    expect(resolvePart('315-5296', index, recognition)?.key).toBe('chip:sega-315-5296');
  });

  it('resolves an alias row', () => {
    expect(resolvePart('MC68000P10', index, recognition)?.chipId).toBe('m68000');
  });

  it('splits a parenthesised catalogue name into both of its forms', () => {
    expect(resolvePart('SH-2', index, recognition)?.chipId).toBe('sh7604');
    expect(resolvePart('SH7604', index, recognition)?.chipId).toBe('sh7604');
  });

  it('applies the configured aliases normalisation cannot reach', () => {
    expect(resolvePart('OKI6295', index, recognition)?.chipId).toBe('msm6295');
    expect(resolvePart('68000', index, recognition)?.chipId).toBe('m68000');
  });

  it('gives an uncatalogued part a part: key rather than inventing a chip', () => {
    const resolved = resolvePart('CPS-B-01', index, recognition);
    expect(resolved?.key).toBe('part:CPSB01');
    expect(resolved?.chipId).toBeUndefined();
  });

  it('refuses to resolve a key two chips claim', () => {
    const ambiguous = buildChipIndex(
      [
        { chip_id: 'first', display_name: 'XY-100' },
        { chip_id: 'second', display_name: 'XY100' },
      ],
      [],
      recognition,
    );
    expect(ambiguous.ambiguous.has('XY100')).toBe(true);
    expect(resolvePart('XY-100', ambiguous, recognition)?.chipId).toBeUndefined();
  });

  it('ignores packages and generic words', () => {
    expect(resolvePart('QFP', index, recognition)).toBeUndefined();
    expect(resolvePart('RAM', index, recognition)).toBeUndefined();
  });
});

describe('scanParts — finding designations in driver prose', () => {
  it('finds a catalogue name with no context word required', () => {
    const hits = scanParts('  YM2151 at 3.579MHz', recognition, index);
    expect(hits.map((hit) => hit.designation)).toContain('YM2151');
  });

  it('tolerates the punctuation a source happens to use', () => {
    expect(scanParts('AY38910 x2', recognition, index).map((h) => h.designation)).toEqual([
      'AY38910',
    ]);
  });

  it('finds a Sega custom only when the line says it is one', () => {
    const legend = scanParts(
      '315-5197 - Custom Sega IC Tilemap Generator (PGA135)',
      recognition,
      index,
    );
    expect(legend.map((hit) => hit.designation)).toContain('315-5197');
    // The same digits with no context word are as likely to be a ROM label as a part.
    expect(scanParts('  lw-315-5197 0x20000', recognition, index)).toEqual([]);
  });

  it('finds the Capcom customs MAME models in driver code and never as a device', () => {
    const hits = scanParts('   Custom chip -   CAPCOM CPS-B-01 (QFP160)', recognition, index);
    expect(hits.map((hit) => hit.designation)).toContain('CPS-B-01');
  });

  it('anchors every grammar, so a package name is not a part number', () => {
    // `GA[0-9]{2}` inside `(PGA135)` used to yield an Irem GA13 on a Sega board.
    const hits = scanParts('  315-5195 - Custom Sega IC (PGA135)', recognition, index);
    expect(hits.map((hit) => hit.designation)).not.toContain('GA13');
    expect(hits.map((hit) => hit.designation)).toContain('315-5195');
  });

  it('reports one hit per designation per line, with the line number and the evidence', () => {
    const hits = scanParts('a\n\n   YM2151 and YM2151 again', recognition, index);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.line).toBe(3);
    expect(hits[0]?.evidence).toBe('YM2151 and YM2151 again');
  });
});
