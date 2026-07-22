/**
 * Hand-built fixture datasets, expressed as row-file bundles so that loading them
 * exercises `src/db/load.ts` (FK-safe order, primary-key sort, one transaction) rather
 * than bypassing it with raw INSERTs.
 *
 * Two independent datasets, because they contradict each other on purpose:
 *
 * - `canonicalQueryFixture` is docs/data-model.md §6's worked example. It gives
 *   `m68000` an FPGA implementation (`fx68k`).
 * - `coverageFixture` is docs/coverage.md §6.0. It deliberately gives `m68000` and
 *   `m6502` no FPGA implementation, so the substitution edges are observable.
 *
 * Chips, manufacturers, functions and equivalence edges are real. Systems, projects and
 * implementations in the coverage fixture carry an `fx-` prefix and are shaped to
 * exercise the views, per that document's convention.
 */
import type { Row, RowFile } from '../src/db/rowfiles.js';

export function bundle(path: string, tables: Readonly<Record<string, readonly Row[]>>): RowFile {
  return { path, tables: new Map(Object.entries(tables)) };
}

const FUNCTIONS: readonly Row[] = [
  {
    function_id: 'cpu',
    label: 'CPU',
    description: 'General-purpose processor executing an instruction stream from external memory.',
    prospector_band: 'medium',
  },
  {
    function_id: 'custom',
    label: 'Custom ASIC',
    description: 'Board-specific ASIC spanning two or more categories with no dominant one.',
    prospector_band: 'hard',
  },
  {
    function_id: 'sound-fm',
    label: 'FM synthesizer',
    description: 'Sound generator whose defining stage is frequency modulation of operators.',
    prospector_band: 'medium',
  },
  {
    function_id: 'sound-psg',
    label: 'PSG',
    description: 'Programmable sound generator producing square, noise and envelope channels.',
    prospector_band: 'medium',
  },
];

const MANUFACTURERS: readonly Row[] = [
  { manufacturer_id: 'motorola', name: 'Motorola', country: 'US' },
  { manufacturer_id: 'mos', name: 'MOS Technology', country: 'US' },
  { manufacturer_id: 'ricoh', name: 'Ricoh', country: 'JP' },
  { manufacturer_id: 'sega', name: 'Sega', country: 'JP' },
  { manufacturer_id: 'texas-instruments', name: 'Texas Instruments', country: 'US' },
  { manufacturer_id: 'yamaha', name: 'Yamaha', country: 'JP' },
  { manufacturer_id: 'zilog', name: 'Zilog', country: 'US' },
];

const ROLES: readonly Row[] = [
  { role_id: 'audiocpu', label: 'Audio CPU' },
  { role_id: 'maincpu', label: 'Main CPU' },
  { role_id: 'sound', label: 'Sound' },
  { role_id: 'subcpu', label: 'Sub CPU' },
  { role_id: 'video', label: 'Video' },
];

const IMPLEMENTATION_KINDS: readonly Row[] = [
  { kind_id: 'fpga_hdl', label: 'FPGA HDL', description: 'Synthesizable hardware description.' },
  {
    kind_id: 'original_silicon',
    label: 'Original silicon',
    description: 'The part or board as manufactured.',
  },
  {
    kind_id: 'software_emulation',
    label: 'Software emulation',
    description: 'A software model of the part or board.',
  },
];

/** The lookup tables both fixtures share. */
export const LOOKUPS: Readonly<Record<string, readonly Row[]>> = {
  accuracy_level: [
    { accuracy_id: 'cycle-accurate', label: 'Cycle accurate', description: 'Matches per cycle.' },
  ],
  chip_function: FUNCTIONS,
  chip_role: ROLES,
  fpga_platform: [
    { platform_id: 'mister', label: 'MiSTer' },
    { platform_id: 'pocket', label: 'Analogue Pocket' },
  ],
  hdl_language: [
    { language_id: 'systemverilog', label: 'SystemVerilog' },
    { language_id: 'verilog', label: 'Verilog' },
    { language_id: 'vhdl', label: 'VHDL' },
  ],
  implementation_kind: IMPLEMENTATION_KINDS,
  license: [
    {
      license_id: 'GPL-3.0-only',
      name: 'GNU General Public License v3.0 only',
      url: 'https://spdx.org/licenses/GPL-3.0-only.html',
      is_osi_approved: 1,
    },
  ],
  manufacturer: MANUFACTURERS,
  system_kind: [{ kind_id: 'arcade', label: 'Arcade' }],
};

const CHIPS: Readonly<Record<string, Row>> = {
  m6502: {
    chip_id: 'm6502',
    display_name: 'MOS 6502',
    function_id: 'cpu',
    manufacturer_id: 'mos',
  },
  m68000: {
    chip_id: 'm68000',
    display_name: 'MC68000',
    function_id: 'cpu',
    manufacturer_id: 'motorola',
  },
  m68010: {
    chip_id: 'm68010',
    display_name: 'MC68010',
    function_id: 'cpu',
    manufacturer_id: 'motorola',
  },
  m68020: {
    chip_id: 'm68020',
    display_name: 'MC68020',
    function_id: 'cpu',
    manufacturer_id: 'motorola',
  },
  m68030: {
    chip_id: 'm68030',
    display_name: 'MC68030',
    function_id: 'cpu',
    manufacturer_id: 'motorola',
  },
  rp2a03: {
    chip_id: 'rp2a03',
    display_name: 'Ricoh RP2A03',
    function_id: 'cpu',
    manufacturer_id: 'ricoh',
  },
  'sega-315-5011': {
    chip_id: 'sega-315-5011',
    display_name: 'Sega 315-5011',
    function_id: 'custom',
    manufacturer_id: 'sega',
  },
  sn76489: {
    chip_id: 'sn76489',
    display_name: 'SN76489',
    function_id: 'sound-psg',
    manufacturer_id: 'texas-instruments',
  },
  ym2151: {
    chip_id: 'ym2151',
    display_name: 'YM2151',
    function_id: 'sound-fm',
    manufacturer_id: 'yamaha',
  },
  ym2612: {
    chip_id: 'ym2612',
    display_name: 'YM2612',
    function_id: 'sound-fm',
    manufacturer_id: 'yamaha',
  },
  ym3438: {
    chip_id: 'ym3438',
    display_name: 'YM3438',
    function_id: 'sound-fm',
    manufacturer_id: 'yamaha',
  },
  z80: { chip_id: 'z80', display_name: 'Z80', function_id: 'cpu', manufacturer_id: 'zilog' },
};

function chips(...ids: readonly string[]): Row[] {
  return ids.map((id) => {
    const chip = CHIPS[id];
    if (chip === undefined) throw new Error(`no fixture chip '${id}'`);
    return chip;
  });
}

/**
 * docs/data-model.md §6 — the Sega System 16A example the canonical queries Q1–Q5 quote
 * expected output for.
 */
export function canonicalQueryFixture(): RowFile[] {
  return [
    bundle('fixture://lookup.json', LOOKUPS),
    bundle('fixture://chips.json', {
      chip: chips('m68000', 'sega-315-5011', 'ym2151', 'z80'),
    }),
    bundle('fixture://system/sega-system16a.json', {
      system: [
        {
          system_id: 'sega-system16a',
          name: 'Sega System 16A',
          kind_id: 'arcade',
          manufacturer_id: 'sega',
          year_introduced: 1985,
        },
      ],
      system_name: [{ system_id: 'sega-system16a', name: 'System 16A', kind: 'alias' }],
      system_driver: [{ mame_sourcefile: 'sega/system16a.cpp', system_id: 'sega-system16a' }],
      system_chip: [
        {
          system_id: 'sega-system16a',
          role_id: 'maincpu',
          chip_id: 'm68000',
          clock_hz: 10000000,
        },
        { system_id: 'sega-system16a', role_id: 'audiocpu', chip_id: 'z80', clock_hz: 4000000 },
        { system_id: 'sega-system16a', role_id: 'sound', chip_id: 'ym2151', clock_hz: 4000000 },
        { system_id: 'sega-system16a', role_id: 'video', chip_id: 'sega-315-5011' },
      ],
    }),
    bundle('fixture://extract/machine.json', {
      machine: [
        {
          machine_id: 'shinobi',
          name: 'Shinobi (set 6, System 16A)',
          mame_sourcefile: 'sega/system16a.cpp',
          mame_year: '1987',
          mame_manufacturer: 'Sega',
          driver_status: 'good',
          is_bios: 0,
          is_device: 0,
          is_mechanical: 0,
        },
      ],
      machine_chip: [
        { machine_id: 'shinobi', mame_tag: 'maincpu', chip_id: 'm68000', clock_hz: 10000000 },
        { machine_id: 'shinobi', mame_tag: 'audiocpu', chip_id: 'z80', clock_hz: 4000000 },
        { machine_id: 'shinobi', mame_tag: 'ym2151', chip_id: 'ym2151', clock_hz: 4000000 },
        { machine_id: 'shinobi', mame_tag: 'gfx', chip_id: 'sega-315-5011' },
      ],
      machine_unmapped_device: [
        { machine_id: 'shinobi', mame_device: 'sega_315_5195', quantity: 1 },
      ],
    }),
    bundle('fixture://implementations.json', {
      project: [
        { project_id: 'jotego', name: 'JOTEGO', url: 'https://github.com/jotego' },
        { project_id: 'ijor', name: 'ijor' },
        { project_id: 'mist-devel', name: 'MiST developers' },
        { project_id: 'mister-devel', name: 'MiSTer developers' },
      ],
      implementation: [
        {
          implementation_id: 'fx68k',
          name: 'fx68k',
          kind_id: 'fpga_hdl',
          project_id: 'ijor',
          hdl_language_id: 'systemverilog',
        },
        {
          implementation_id: 'jt51',
          name: 'JT51',
          kind_id: 'fpga_hdl',
          project_id: 'jotego',
          hdl_language_id: 'verilog',
          license_id: 'GPL-3.0-only',
        },
        {
          implementation_id: 't80',
          name: 'T80',
          kind_id: 'fpga_hdl',
          project_id: 'mist-devel',
          hdl_language_id: 'vhdl',
        },
        {
          implementation_id: 'mister-arcade-s16a',
          name: 'MiSTer Arcade System 16A',
          kind_id: 'fpga_hdl',
          project_id: 'mister-devel',
        },
      ],
      implementation_chip: [
        { implementation_id: 'fx68k', chip_id: 'm68000' },
        { implementation_id: 'jt51', chip_id: 'ym2151' },
        { implementation_id: 't80', chip_id: 'z80' },
      ],
      implementation_system: [
        { implementation_id: 'mister-arcade-s16a', system_id: 'sega-system16a' },
      ],
      implementation_platform: [{ implementation_id: 'mister-arcade-s16a', platform_id: 'mister' }],
      implementation_path: [
        { implementation_id: 'fx68k', path: 'fx68k.sv', is_top: 1 },
        { implementation_id: 'jt51', path: 'hdl/jt51.v', is_top: 1 },
        { implementation_id: 'jt51', path: 'hdl/jt51_op.v' },
        { implementation_id: 't80', path: 'T80.vhd', is_top: 1 },
      ],
      implementation_dependency: [
        { consumer_id: 'mister-arcade-s16a', provider_id: 'fx68k', note: '68000 core' },
        { consumer_id: 'mister-arcade-s16a', provider_id: 'jt51', note: 'OPM sound' },
        { consumer_id: 'mister-arcade-s16a', provider_id: 't80', note: 'Z80 sound CPU' },
      ],
    }),
  ];
}

/** docs/coverage.md §6.0 — the eight worked examples plus §6.9's additional cases. */
export function coverageFixture(): RowFile[] {
  return [
    bundle('fixture://lookup.json', LOOKUPS),
    bundle('fixture://chips.json', {
      chip: [
        ...chips(
          'm6502',
          'm68000',
          'm68010',
          'm68020',
          'm68030',
          'rp2a03',
          'sega-315-5011',
          'sn76489',
          'ym2151',
          'ym2612',
          'ym3438',
          'z80',
        ),
        // §6.9 "two providers tied at the same rank". No system uses these, so they
        // touch no coverage number; they exist only to pin the MIN() tie-break.
        { chip_id: 'fx-tie-hi', display_name: 'FX tie high', function_id: 'custom' },
        { chip_id: 'fx-tie-lo', display_name: 'FX tie low', function_id: 'custom' },
        { chip_id: 'fx-tie-socket', display_name: 'FX tie socket', function_id: 'custom' },
      ],
    }),
    bundle('fixture://chip_equivalence.json', {
      chip_equivalence: [
        {
          from_chip_id: 'm68010',
          to_chip_id: 'm68000',
          kind: 'provides',
          note: 'The MC68010 is an instruction-set superset of the MC68000 on the same bus; a 68000 socket is served by 68010 silicon. Source: MC68010 user manual §1.',
        },
        {
          from_chip_id: 'm68020',
          to_chip_id: 'm68010',
          kind: 'provides',
          note: 'The MC68020 is a superset of the MC68010 instruction set. Source: MC68020 user manual §1.',
        },
        {
          from_chip_id: 'm68030',
          to_chip_id: 'm68020',
          kind: 'provides',
          note: 'The MC68030 is an MC68020 with an on-die MMU and caches. Source: MC68030 user manual §1.',
        },
        {
          from_chip_id: 'ym2612',
          to_chip_id: 'ym3438',
          kind: 'equivalent',
          note: 'The YM3438 is the CMOS die shrink of the YM2612, register-compatible in both directions; the ladder-DAC difference is an output-stage artefact, not a programming-model one. Source: Yamaha OPN2 application notes.',
        },
        {
          from_chip_id: 'fx-tie-hi',
          to_chip_id: 'fx-tie-socket',
          kind: 'provides',
          note: 'Fixture edge for the provider tie-break in coverage.md §6.9; not a real part relationship.',
        },
        {
          from_chip_id: 'fx-tie-lo',
          to_chip_id: 'fx-tie-socket',
          kind: 'provides',
          note: 'Fixture edge for the provider tie-break in coverage.md §6.9; not a real part relationship.',
        },
      ],
    }),
    bundle('fixture://systems.json', {
      system: [
        { system_id: 'fx-2a03', name: 'FX 2A03', kind_id: 'arcade' },
        { system_id: 'fx-68k-hit', name: 'FX 68k hit', kind_id: 'arcade' },
        { system_id: 'fx-68k-miss', name: 'FX 68k miss', kind_id: 'arcade' },
        { system_id: 'fx-68k-notrans', name: 'FX 68k no transitivity', kind_id: 'arcade' },
        { system_id: 'fx-empty', name: 'FX empty', kind_id: 'arcade' },
        { system_id: 'fx-kind', name: 'FX kind', kind_id: 'arcade' },
        { system_id: 'fx-symmetric', name: 'FX symmetric', kind_id: 'arcade' },
        { system_id: 'fx-unmapped-low', name: 'FX unmapped low', kind_id: 'arcade' },
        { system_id: 'fx-unmapped-med', name: 'FX unmapped medium', kind_id: 'arcade' },
      ],
      system_driver: [
        { mame_sourcefile: 'fx/low.cpp', system_id: 'fx-unmapped-low' },
        { mame_sourcefile: 'fx/med.cpp', system_id: 'fx-unmapped-med' },
      ],
      system_chip: [
        { system_id: 'fx-symmetric', role_id: 'audiocpu', chip_id: 'z80' },
        { system_id: 'fx-symmetric', role_id: 'sound', chip_id: 'sn76489' },
        { system_id: 'fx-symmetric', role_id: 'sound', chip_id: 'ym2612' },
        { system_id: 'fx-symmetric', role_id: 'video', chip_id: 'sega-315-5011' },

        { system_id: 'fx-68k-hit', role_id: 'maincpu', chip_id: 'm68010' },
        { system_id: 'fx-68k-hit', role_id: 'audiocpu', chip_id: 'z80' },

        { system_id: 'fx-68k-miss', role_id: 'maincpu', chip_id: 'm68030' },
        { system_id: 'fx-68k-miss', role_id: 'audiocpu', chip_id: 'z80' },
        { system_id: 'fx-68k-miss', role_id: 'sound', chip_id: 'sn76489' },

        { system_id: 'fx-68k-notrans', role_id: 'maincpu', chip_id: 'm68000' },
        { system_id: 'fx-68k-notrans', role_id: 'audiocpu', chip_id: 'z80' },

        { system_id: 'fx-2a03', role_id: 'maincpu', chip_id: 'm6502' },
        { system_id: 'fx-2a03', role_id: 'subcpu', chip_id: 'rp2a03' },
        { system_id: 'fx-2a03', role_id: 'sound', chip_id: 'sn76489' },

        { system_id: 'fx-unmapped-med', role_id: 'maincpu', chip_id: 'm68020' },
        { system_id: 'fx-unmapped-med', role_id: 'subcpu', chip_id: 'rp2a03' },
        { system_id: 'fx-unmapped-med', role_id: 'sound', chip_id: 'sn76489' },
        { system_id: 'fx-unmapped-med', role_id: 'sound', chip_id: 'ym3438' },
        { system_id: 'fx-unmapped-med', role_id: 'audiocpu', chip_id: 'z80' },

        { system_id: 'fx-unmapped-low', role_id: 'maincpu', chip_id: 'm68020' },
        { system_id: 'fx-unmapped-low', role_id: 'sound', chip_id: 'sn76489' },
        { system_id: 'fx-unmapped-low', role_id: 'sound', chip_id: 'ym3438' },
        { system_id: 'fx-unmapped-low', role_id: 'audiocpu', chip_id: 'z80' },

        { system_id: 'fx-kind', role_id: 'audiocpu', chip_id: 'z80' },
        { system_id: 'fx-kind', role_id: 'sound', chip_id: 'ym2151' },
        { system_id: 'fx-kind', role_id: 'video', chip_id: 'sega-315-5011' },
      ],
    }),
    bundle('fixture://extract/machine.json', {
      machine: [
        {
          machine_id: 'fxlow1',
          name: 'FX unmapped low title',
          mame_sourcefile: 'fx/low.cpp',
          is_bios: 0,
          is_device: 0,
          is_mechanical: 0,
        },
        {
          machine_id: 'fxmed1',
          name: 'FX unmapped medium title',
          mame_sourcefile: 'fx/med.cpp',
          is_bios: 0,
          is_device: 0,
          is_mechanical: 0,
        },
      ],
      machine_unmapped_device: [
        { machine_id: 'fxlow1', mame_device: 'fx_gate_array' },
        { machine_id: 'fxlow1', mame_device: 'fx_pal16r8' },
        { machine_id: 'fxmed1', mame_device: 'fx_gate_array' },
      ],
    }),
    bundle('fixture://implementations.json', {
      implementation: [
        { implementation_id: 'fx-2a03-hdl', name: 'FX 2A03 HDL', kind_id: 'fpga_hdl' },
        { implementation_id: 'fx-68020-hdl', name: 'FX 68020 HDL', kind_id: 'fpga_hdl' },
        {
          implementation_id: 'fx-core-symmetric',
          name: 'FX symmetric core',
          kind_id: 'fpga_hdl',
        },
        { implementation_id: 'fx-opn2-hdl', name: 'FX OPN2 HDL', kind_id: 'fpga_hdl' },
        { implementation_id: 'fx-psg-hdl', name: 'FX PSG HDL', kind_id: 'fpga_hdl' },
        { implementation_id: 'fx-tie-hi-hdl', name: 'FX tie high HDL', kind_id: 'fpga_hdl' },
        { implementation_id: 'fx-tie-lo-hdl', name: 'FX tie low HDL', kind_id: 'fpga_hdl' },
        { implementation_id: 'fx-z80-hdl', name: 'FX Z80 HDL', kind_id: 'fpga_hdl' },
        // §6.9 "two implementations of the same chip and kind": collapses in v_chip_satisfied.
        { implementation_id: 'fx-z80-hdl-alt', name: 'FX Z80 HDL (alt)', kind_id: 'fpga_hdl' },
        {
          implementation_id: 'fx-mame-315-5011',
          name: 'MAME 315-5011',
          kind_id: 'software_emulation',
        },
        { implementation_id: 'fx-mame-ym2151', name: 'MAME YM2151', kind_id: 'software_emulation' },
        { implementation_id: 'fx-mame-z80', name: 'MAME Z80', kind_id: 'software_emulation' },
      ],
      implementation_chip: [
        { implementation_id: 'fx-2a03-hdl', chip_id: 'rp2a03' },
        { implementation_id: 'fx-68020-hdl', chip_id: 'm68020' },
        { implementation_id: 'fx-opn2-hdl', chip_id: 'ym3438' },
        { implementation_id: 'fx-psg-hdl', chip_id: 'sn76489' },
        { implementation_id: 'fx-tie-hi-hdl', chip_id: 'fx-tie-hi' },
        { implementation_id: 'fx-tie-lo-hdl', chip_id: 'fx-tie-lo' },
        { implementation_id: 'fx-z80-hdl', chip_id: 'z80' },
        { implementation_id: 'fx-z80-hdl-alt', chip_id: 'z80' },
        { implementation_id: 'fx-mame-315-5011', chip_id: 'sega-315-5011' },
        { implementation_id: 'fx-mame-ym2151', chip_id: 'ym2151' },
        { implementation_id: 'fx-mame-z80', chip_id: 'z80' },
      ],
      implementation_system: [
        { implementation_id: 'fx-core-symmetric', system_id: 'fx-symmetric' },
      ],
      implementation_platform: [{ implementation_id: 'fx-core-symmetric', platform_id: 'mister' }],
    }),
  ];
}
