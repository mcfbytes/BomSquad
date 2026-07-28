# BOM Squad Chip Function Taxonomy

**Spec version 2.0.0 · Normative for the contents of the `chip_function` table**

This document owns the `chip_function` lookup table: its rows, their `prospector_band` values, and the rules a
curator follows to pick the right `chip.function_id`. The seed data lives at
[`data/lookup/chip_function.json`](../data/lookup/chip_function.json); where that file and this document
disagree, this document wins and the file is wrong.

The key words MUST, MUST NOT, REQUIRED, SHOULD, SHOULD NOT, MAY, and OPTIONAL are to be interpreted as
described in RFC 2119.

Constraints inherited from [data-model.md](data-model.md) and NOT negotiable here:

- `chip.function_id` is a single `TEXT NOT NULL` column with `REFERENCES chip_function(function_id) ON DELETE
RESTRICT`. There is no array form, no secondary function, no tag list; a chip that referenced two functions
  would need two rows in `chip`, which the primary key forbids.
- `function_id` is a lookup-table key, so it obeys the slug grammar `^[a-z0-9]+(?:-[a-z0-9]+)*$`
  (data-model §3.2). Branch separators are therefore **hyphens**, not dots: `sound-fm`, `video-tilemap`.
  (data-model §1.2 illustrates the column with dotted examples; the grammar in §3.2 is the enforced rule and
  wins. The branch is a naming convention only — SQL never parses it, and no query MUST rely on the prefix.)
- There is no `unknown` value. v1 minted `unknown:` chip stubs; the relational model records an unclassified
  MAME device as `machine_unmapped_device` rows and surfaces it through `v_mame_device_worklist`, so the
  taxonomy never has to name the absence of knowledge.

Adding a value is a pure data change: one row in `data/lookup/chip_function.json` plus one section here. No
schema edit, no code change. That is the whole point of the lookup table (data-model §1.1, lookup-table rule).

---

## 1. Governing principle

> **Classify a part by its primary reason for being — the one function that, if removed, would leave nothing
> worth buying the part for.**

Three corollaries, all normative:

**P1 — Classify the part, not the instance.** `function_id` is an attribute of the `chip` row, and one `chip`
row is referenced by every `system_chip` and `machine_chip` row that uses the part. A stock Microchip PIC16C57
soldered to a bootleg board purely as a protection dongle is still `mcu`; a Z80 used as a sound CPU is still
`cpu`. Per-board role belongs in `system_chip.role_id` (a `chip_role` FK) and per-title placement in
`machine_chip.mame_tag`, never in the taxonomy.

**P2 — One value, always.** Every chip lands on exactly one value. Multi-function parts are resolved by §2,
not by picking the most flattering label. Two chips with genuinely overlapping duties may still take different
values; that is expected, not a defect.

**P3 — Prefer the specific value; fall back only when forced.** `custom` and `glue` are terminal fallbacks,
not conveniences. A part MUST NOT be filed as `custom` because nobody has looked it up yet — that is what
leaving the MAME device unmapped is for (TB8).

---

## 2. Tie-break rules

Applied in order. The first rule that fires decides.

**TB1 — Instruction execution absorbs everything.** If the part fetches and executes a general-purpose
instruction stream, it is `cpu` or `mcu` (split by TB2) regardless of what else is integrated on the die.
Rationale: an FPGA port must implement the core first; everything bolted to it is downstream work.
_Consequences:_ Ricoh 2A03 (6502 core + APU) → `cpu`, not `sound-psg`. Hudson HuC6280 (65C02 core + PSG + MMU

- timer) → `cpu`. Ricoh 5A22 (65C816 core + DMA + PPU timing) → `cpu`. Taito TC0090LVC (Z80 core + tilemap +
  sprite generation) → `cpu`. Motorola 68000 sold as the Sega FD1094 encrypted module → `cpu`.

**TB2 — On-die program store means `mcu`.** Among instruction executors: if the part normally runs from
program memory on its own die (mask ROM, EPROM, OTP, or flash) and carries integrated peripherals, it is
`mcu`. If it fetches its program from external memory across a bus, it is `cpu`.
_Consequences:_ Intel 8751 → `mcu`. Hitachi HD63701 → `mcu`. Namco 5xXX/6xXX satellite controllers → `mcu`.
Zilog Z80, Motorola 68000, MOS 6502 → `cpu`.

**TB3 — Within one top-level branch, the defining stage wins.** If every function of the part lives inside the
same branch (`sound-*` or `video-*`), classify by the stage that defines the part rather than splitting it.
_Consequences:_ Yamaha YM2610 (FM + SSG + ADPCM) → `sound-fm`; the FM engine is why it exists. Yamaha YM2413
(FM with a built-in instrument ROM) → `sound-fm`; the ROM is a parameter table, not a sample bank. Sega
315-5313 (Mega Drive VDP: tilemaps, sprites, CRTC, DMA) → `video-ppu`; an integrated video processor is a
`video-ppu` by definition (§4.20). Yamaha V9938 → `video-ppu` even though it also blits.

**TB4 — Service functions inherit their master's branch.** DMA, address generation, timing, and buffering
built into a part to serve one branch do not pull the part out of that branch.
_Consequences:_ Commodore Agnus (blitter + copper + DMA arbitration + display timing) → `video-blitter`; the
DMA and timing exist to feed the display. A sample-ROM address generator that exists only to drive a companion
PCM channel → `sound-pcm`.

**TB5 — No dominant function across branches ⇒ `custom`.** If a part spans two or more top-level categories
(counting all of `video-*` as one category and all of `sound-*` as one) with no dominant one, and it is a
board-specific ASIC rather than a catalog part, it is `custom`. A **catalog part** is one designed as a
standalone product with its own part identity and reused across unrelated boards — open-market sale is not
required (Atari POKEY was never sold openly and is catalog). A part designed as one member of a single
architecture's chipset is board-specific, however many boards that architecture shipped on.
_Consequences:_ Capcom CPS-B-21 (video mixing/priority + sprite control + per-game protection registers) →
`custom`. Data East 146 (protection + I/O + interrupt handling) → `custom`. Sega SCU (DMA + DSP + interrupt
control) → `custom`. MOS 8364 "Paula" (PCM audio + floppy + serial/interrupts, an Amiga chipset member) →
`custom`. Atari POKEY (PSG + pot/keyboard scanning + serial) → **not** TB5 — a catalog part; Q5 then gives
`sound-psg`.

**TB6 — Design intent beats deployment.** A catalog part keeps its catalog function even when a board abuses
it (P1). Only parts _designed_ as security devices take `protection`.
_Consequences:_ Dallas DS5002FP (a secure 8051 variant, used as a protected program store by Gaelco) → `mcu`.
Nintendo CIC → `protection`, because lockout is its whole purpose.

**TB7 — Analog output stage vs. digital generator.** The part that produces the digital sample/pixel stream
takes the generating value; the part that converts it to volts takes `sound-dac` or `video-dac`. When one die
does both, the generator wins (TB3).

**TB8 — Unresolvable means no chip row, not `custom`.** If the part's function is genuinely unknown, do not
create a `chip` row. Leave the device out of `mame_device`, or give it a `mame_device` row with an
`ignore_reason` if it is not a chip at all. Unmapped devices then appear in `machine_unmapped_device`, are
counted by `v_system_coverage.unmapped_device_count`, and are queued for curation by
`v_mame_device_worklist`. Filing a guess as `custom` destroys that signal and violates standing rule 3.

---

## 3. Decision guide

Ordered questions, answered about the part's **primary reason for being** (§1): the reading is "is this what
the part is for?", never "does the part do this somewhere on the die?". A timekeeper NVRAM contains an
addressable store, but Q8 is honestly answered no — the clock is what the part is for (§4.8). Q1 is the one
deliberate exception: TB1 absorbs purpose, so an instruction-executing part is `cpu` or `mcu` whatever it was
built to do.

**§2 outranks this list.** The tie-break rules exist for exactly the parts where more than one question could
honestly claim a yes; when you notice that, stop walking and apply §2 in order — a tie-break that fires
decides the value, and question order never overrules it. Walked blind, the list would file Amiga Paula under
Q5 as `sound-pcm` and never reach Q12; TB5 files it as `custom`, and TB5 wins. When no tie-break fires —
which is the catalog-part case TB5 excludes — the sequence itself is the dominance rule: answer in order and
stop at the first **yes**. That is how POKEY (PSG + pot/keyboard scanning + serial) lands on `sound-psg`, not
`io`.

The result is deterministic — two curators applying §2 and then this list MUST reach the same value.

| #   | Question                                                                                                                                                                                                                   | Value                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 0   | Is the part's function genuinely unknown to you?                                                                                                                                                                           | **stop** — leave the device unmapped (TB8); write no `chip` |
| 1   | Does it fetch and execute a general-purpose instruction stream (TB1)?                                                                                                                                                      | → 1a                                                        |
| 1a  | …from program memory on its own die, with integrated peripherals (TB2)?                                                                                                                                                    | `mcu`                                                       |
| 1b  | …from external memory across a bus?                                                                                                                                                                                        | `cpu`                                                       |
| 2   | Is it a math or signal engine — DSP, FPU, geometry/transform unit — driven by a host CPU, with its algorithm in microcode or firmware the part executes? (A fixed-silicon decoder for a published format is not one — A2.) | `dsp`                                                       |
| 3   | Was it designed to enforce security: lockout, decryption, keyed challenge/response, tamper response (TB6)?                                                                                                                 | `protection`                                                |
| 4   | Does it generate or compose the video signal, or drive the picture pipeline?                                                                                                                                               | → §3.1                                                      |
| 5   | Does it generate, mix, or convert audio?                                                                                                                                                                                   | → §3.2                                                      |
| 6   | Does it manage a mass-storage medium — floppy, hard disk, CD/GD-ROM, SCSI/IDE, tape?                                                                                                                                       | `storage`                                                   |
| 7   | Does it move data between memory regions or devices without CPU cycles per transfer?                                                                                                                                       | `dma`                                                       |
| 8   | Does it control address decoding, banking, translation, or memory arrays — or is it itself an addressable non-volatile store (EEPROM/NVRAM)?                                                                               | `memory`                                                    |
| 9   | Does it keep wall-clock time or a calendar, typically battery-backed?                                                                                                                                                      | `rtc`                                                       |
| 10  | Is its purpose generating programmable time intervals, counts, or periodic interrupts?                                                                                                                                     | `timer`                                                     |
| 11  | Does it interface the system to peripherals, operators, other boards, or a network — parallel/serial ports, controller reads, interrupt priority, sound latches, coin/ticket handling?                                     | `io`                                                        |
| 12  | Does it span two or more of the above categories with no dominant one, as a board-specific ASIC (TB5)?                                                                                                                     | `custom`                                                    |
| 13  | Otherwise: is it catalog logic — 74-series, PAL/GAL, decoder, latch, buffer, driver, comparator, clock generator, reset supervisor?                                                                                        | `glue`                                                      |

If you reach the end without a yes, re-read Q0 — the honest answer is usually that the function is not
actually known.

### 3.1 Video sub-guide (reached from Q4)

| #   | Question                                                                                                                  | Value           |
| --- | ------------------------------------------------------------------------------------------------------------------------- | --------------- |
| V1  | Does one die produce a complete picture — tile layers **and** sprites **and** sync/timing — as an integrated unit?        | `video-ppu`     |
| V2  | Does it draw into a framebuffer or line buffer from a command/display list (bitmap blits, polygon fills, vector strokes)? | `video-blitter` |
| V3  | Does it generate scrolling tile/character layers from a map + character ROM/RAM, including affine (rotate/zoom) layers?   | `video-tilemap` |
| V4  | Does it fetch, position, size, or line-buffer movable objects?                                                            | `video-sprite`  |
| V5  | Does it combine already-generated layers — priority resolution, palette lookup, shadow/highlight, colour RAM?             | `video-mixer`   |
| V6  | Does it generate raster timing — H/V sync, blanking, display addresses — without generating pixel content?                | `video-crtc`    |
| V7  | Does it convert digital pixel data to analog video, or encode RGB to composite/S-video/component?                         | `video-dac`     |

V1's three parts are all load-bearing, and "tile layers" means scrolling tilemaps in V3's sense. A dominant
sprite engine that also emits sync and a fixed character overlay — the SNK LSPC2-A2, whose fix layer neither
scrolls nor forms the background — stays `video-sprite`: TB3 classifies by the defining stage, and TB4 keeps
the timing with its master. V1 is for parts where the integrated whole, not one stage plus its servants, is
the product.

### 3.2 Audio sub-guide (reached from Q5)

| #   | Question                                                                                                                     | Value             |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| A1  | Does it synthesize by operator/carrier frequency modulation?                                                                 | `sound-fm`        |
| A2  | Does it play back recorded samples from ROM/RAM (PCM, ADPCM, MP3-era codecs), or address sample ROM for a companion channel? | `sound-pcm`       |
| A3  | Does it synthesize speech from LPC/formant/allophone parameters rather than sample playback?                                 | `sound-speech`    |
| A4  | Does it play arbitrary user-supplied waveforms from waveform RAM/ROM?                                                        | `sound-wavetable` |
| A5  | Does it generate tones from fixed square/pulse/triangle/noise generators with envelopes?                                     | `sound-psg`       |
| A6  | Is it purely a digital-to-analog converter for an audio stream?                                                              | `sound-dac`       |
| A7  | Is it an analog or discrete audio circuit — op-amp, filter, VCO/timer used as an oscillator, power amplifier?                | `sound-analog`    |

Q2 precedes this sub-guide, so a programmable engine running signal-processing microcode never reaches A1–A7:
QSound (a DSP16A core running the DL-1425 program), ES5510, TMS57002 and DSP56362 are all `dsp`, whatever
their output jacks carry. A2's "MP3-era codecs" means the opposite kind of part — a fixed-silicon decoder for
a published format (Micronas MAS3507D), where an implementation reproduces the format, not the firmware.

---

## 4. The rows

26 rows. Each entry gives the `label` and `description` as seeded, the `prospector_band` with its reason, real
example parts, and the neighbours it is confused with.

### 4.1 `cpu` — CPU · band `medium`

**Definition.** A general-purpose processor that fetches and executes an instruction stream from memory
external to the die. Includes bit-slice ALU families whose reason for being is to build a processor, and
encrypted/repackaged variants of catalog CPUs.

**Examples.** Zilog Z80 · Motorola MC68000 · MOS 6502 · Intel 8080 · Ricoh 2A03 (TB1) · Hudson HuC6280 (TB1) ·
AMD Am2901 (bit-slice ALU) · Hitachi SH-2.

**Confused with.**

- `mcu` — on-die program store and integrated peripherals (TB2). Z80 = `cpu`; 8751 = `mcu`.
- `dsp` — a DSP runs a fixed-function math kernel under a host; a CPU runs the system. If it is the machine's
  `maincpu`/`audiocpu`, it is a CPU.
- `custom` — TB1 outranks TB5: an ASIC with a CPU core inside is still `cpu`.

### 4.2 `mcu` — Microcontroller · band `medium`

**Definition.** A microcontroller: instruction execution plus on-die program store plus integrated peripherals
(ports, timers, sometimes ADC), normally deployed as a satellite processor or a protected program container.

**Examples.** Intel 8751 · Motorola MC68705P3 · Hitachi HD63701 · Namco 51XX/52XX/53XX/54XX satellite
controllers · Microchip PIC16C57 · Dallas DS5002FP (TB6).

**Confused with.**

- `cpu` — TB2. External program bus ⇒ `cpu`.
- `protection` — TB6. A stock MCU used as a dongle is `mcu`; only purpose-built security silicon is
  `protection`.
- `io` — an MCU that scans inputs still executes code; `io` parts are fixed-function.

### 4.3 `dsp` — DSP / coprocessor · band `hard`

**Definition.** A fixed-purpose math or signal coprocessor driven by a host CPU: digital signal processors,
floating-point units, geometry/transform engines, and 3D matrix processors. The algorithm is the part's
program — microcode or firmware an implementation must reproduce.

**Examples.** Texas Instruments TMS32010 · Texas Instruments TMS320C31 · Analog Devices ADSP-2105 · NEC
µPD77C25 (Nintendo DSP-1) · Fujitsu MB86233 (Sega Model 2 TGP) · Motorola MC68881 (FPU) · Capcom QSound
(DL-1425, a DSP16A core running mask microcode).

**Confused with.**

- `cpu` — a DSP is a coprocessor, not the system processor; it typically has no interrupt-driven OS role and a
  Harvard bus.
- `mcu` — DSPs often boot from internal ROM too; the discriminator is the workload (multiply-accumulate math
  on a data stream) not the memory topology. Q2 sits after Q1, so a part that also serves as a general
  processor takes `cpu`/`mcu`.
- `sound-pcm` — the split is where the algorithm lives (Q2). A microcode engine whose output happens to be
  audio (QSound, ES5510, TMS57002, DSP56362) is `dsp`; a fixed-silicon decoder for a published format
  (MAS3507D) is `sound-pcm` under A2.
- `custom` — a documented math engine is `dsp` even when it is a board-specific part.

**Band.** `hard` — the parts are usually undocumented microcode engines whose firmware must be reproduced
cycle-for-cycle.

### 4.4 `dma` — DMA controller · band `soft`

**Definition.** A bus-mastering transfer engine that moves blocks between memory and devices without per-word
CPU involvement, as its principal job.

**Examples.** Intel 8237A · Zilog Z8410 (Z80 DMA) · Motorola MC68450 · NEC µPD71071.

**Confused with.**

- `io` — DMA controllers master the bus; peripheral interfaces are slaves. If the CPU must move every byte, it
  is `io`.
- `memory` — DMA moves data, memory controllers decide where data lives.
- `video-blitter` — a blitter draws (raster ops, masks, patterns); a DMA controller only copies. TB4 keeps
  display-service DMA inside `video-*`.

**Why it exists as a row.** DMA controllers appear in almost every 16-bit-and-up board and console (X68000,
Amiga, Saturn, PC-based arcade hardware) and are timing-critical work in an FPGA port, which `io` would hide.

### 4.5 `memory` — Memory control and storage · band `soft`

**Definition.** Parts that govern the address space or store data as their function: memory controllers, MMUs,
bank switchers and cartridge mappers, DRAM controllers/refresh generators, and addressable non-volatile
stores.

**Examples.** Nintendo MMC1 and MMC3 (cartridge mappers) · Sega 315-5195 (System 18/X-Board memory mapper) ·
Motorola MC68851 (PMMU) · Atmel/ST 93C46 serial EEPROM · Konami VRC4.

**Confused with.**

- `glue` — a PAL that decodes four chip selects is `glue`; a programmable, CPU-visible mapper with registers
  is `memory`.
- `dma` — see §4.4.
- `protection` — many mappers (VRC4, MMC-era clones) carry incidental scrambling. Unless security is the
  purpose (TB6), keep `memory`.

**Why it exists as a row.** Cartridge mappers alone account for dozens of distinct parts on NES/SNES/Mega Drive
BOMs; `custom` would bury them and wrongly mark those systems hard for what is usually easy HDL.

### 4.6 `protection` — Protection · band `hard`

**Definition.** Silicon designed to gate operation: lockout chips, bus/opcode decryptors, keyed
challenge-response ASICs, and tamper-response security parts.

**Examples.** Atari SLAPSTIC (137412 series) · Nintendo CIC (10NES lockout) · Sega 315-5881 (ST-V/NAOMI
encryption ASIC) · Taito TC0030CMD (C-Chip).

**Confused with.**

- `mcu` — TB6. A general MCU running secret code is `mcu`.
- `cpu` — TB1. An encrypted CPU module (FD1089, FD1094, Capcom Kabuki) is `cpu`; the decryption is a property
  of the core's fetch path.
- `custom` — if security is the dominant purpose it is `protection`; only genuinely multi-role ASICs fall to
  `custom`.

**Band.** `hard` — protection parts are the single most common reason a board resists emulation or an FPGA
port, and they frequently have no public documentation at all.

### 4.7 `storage` — Mass-storage controller · band `medium`

**Definition.** Controllers for a mass-storage medium: floppy, hard disk, CD/GD-ROM, SCSI/IDE host adapters,
tape.

**Examples.** NEC µPD765A · Western Digital WD1772 · Western Digital WD33C93 (SCSI) · Fujitsu MB89352 (SCSI) ·
NCR 53C700.

**Confused with.**

- `io` — storage controllers manage a medium (sectors, seeks, error correction); `io` parts move bytes through
  a port.
- `memory` — storage is block-addressed and removable/mechanical; `memory` is byte-addressed in the CPU map.

**Why it exists as a row.** Disc-based systems (X68000, ST-V/NAOMI GD-ROM, Saturn, PC-based arcade) put these
on the BOM in numbers, and their emulation burden is nothing like a PIA's.

### 4.8 `rtc` — Real-time clock · band `soft`

**Definition.** Real-time clock/calendar parts that track wall-clock time across power-off, usually
battery-backed, often with a little NVRAM attached.

**Examples.** Ricoh RP5C01 · OKI MSM6242B · Motorola MC146818 · Dallas DS1302 · SGS-Thomson M48T58
(timekeeper NVRAM).

**Confused with.**

- `timer` — a `timer` counts a system clock to produce intervals/interrupts and stops at power-off; an `rtc`
  keeps calendar time and survives it.
- `memory` — timekeeper NVRAM parts do both; the clock is the reason they cost more than an SRAM, so `rtc`
  wins.

**Why it exists as a row.** RTCs are ubiquitous in Konami, Sega and Taito hardware with bookkeeping menus;
folding them into `timer` would mislabel a distinct behaviour.

### 4.9 `timer` — Timer / counter · band `soft`

**Definition.** Programmable interval timers, counters, and watchdogs whose purpose is generating timed events
or periodic interrupts.

**Examples.** Intel 8253/8254 PIT · Motorola MC6840 PTM · Zilog Z8430 (Z80 CTC) · Texas Instruments
TMS9902-family timing sections.

**Confused with.**

- `rtc` — §4.8.
- `io` — multifunction peripherals that bundle a timer with ports/UART/interrupts (MC68901 MFP, Z80 PIO-plus
  parts) go to `io` unless the timer clearly dominates.
- `video-crtc` — display timing generators are `video-crtc`, not `timer`.

### 4.10 `io` — I/O and system control · band `soft`

**Definition.** Fixed-function interface and system-control parts: parallel/serial port controllers, UARTs,
controller/coin/ticket input handlers, sound latches and inter-CPU mailboxes, interrupt priority controllers,
network/link interfaces.

**Examples.** Motorola MC6821 PIA · Intel 8255 PPI · Intel 8251 USART · Zilog Z8420 (Z80 PIO) · Intel 8259A
(interrupt controller) · Motorola MC68901 MFP · Sega 315-5296 (I/O) · Taito TC0640FIO · Konami 056230
(link/LAN).

**Confused with.**

- `mcu` — §4.2.
- `dma` / `storage` — §4.4, §4.7.
- `glue` — a `74LS244` buffering a joystick is `glue`; a register-programmable port controller is `io`.

**Note.** A dedicated `interrupt` row was considered and rejected: standalone interrupt controllers (8259A and
near-relatives) are few, and every other candidate part (MFP, CTC, TMS9901) bundles interrupts with ports or
timers. Interrupt controllers therefore live in `io`, per Q11. Because the value set is a table, this decision
is cheap to revisit — adding the row later is a data change plus a §4 section.

### 4.11 `sound-fm` — FM synthesis · band `medium`

**Definition.** Synthesis by frequency modulation between operator cells — the Yamaha OPx line and its
relatives.

**Examples.** Yamaha YM2151 (OPM) · Yamaha YM2203 (OPN) · Yamaha YM2612 / YM3438 (OPN2) · Yamaha YM2413
(OPLL) · Yamaha YM3812 (OPL2) · Yamaha YM2610 (TB3).

**Confused with.**

- `sound-psg` — FM parts commonly embed an SSG/PSG section (YM2203, YM2610); TB3 keeps them `sound-fm`.
- `sound-pcm` — likewise for embedded ADPCM channels (YM2610, YM2608).
- `sound-dac` — the companion DAC/attenuator (YM3012, YM3014B) is a separate part and takes `sound-dac`.

### 4.12 `sound-psg` — Programmable sound generator · band `medium`

**Definition.** Programmable sound generators built from a fixed set of square/pulse/triangle/noise channels
with envelope and volume control, and no user-supplied waveform.

**Examples.** General Instrument AY-3-8910 · Yamaha YM2149 · Texas Instruments SN76489 · MOS 6581/8580 SID.

**Confused with.**

- `sound-wavetable` — the discriminator is whether the waveform comes from RAM/ROM the program writes
  (`sound-wavetable`) or from fixed generators (`sound-psg`).
- `sound-fm` — §4.11.
- `cpu` — TB1: a CPU with a PSG on-die (2A03, HuC6280) is `cpu`.

### 4.13 `sound-wavetable` — Wavetable synthesis · band `medium`

**Definition.** Tone generation from arbitrary short waveforms held in waveform RAM/ROM, looped at a
programmable rate — distinct from both fixed-generator PSGs and streamed sample playback.

**Examples.** Namco WSG (Pac-Man/Galaga 3-channel) · Namco 15XX (Mappy, Super Pac-Man) · Konami K051649 (SCC) ·
Konami K052539 (SCC+).

**Confused with.**

- `sound-psg` — §4.12.
- `sound-pcm` — a wavetable loops a few dozen samples as an oscillator; PCM streams a recording with an address
  counter that runs to an end marker.

**Why it exists as a row.** The Namco WSG family and Konami SCC are among the most-implemented sound blocks in
the FPGA scene; misfiling them as `sound-psg` would make the taxonomy lie about a dozen high-traffic chips.

### 4.14 `sound-pcm` — Sample playback · band `medium`

**Definition.** Sample playback engines: PCM, ADPCM, and later compressed formats, including the address
generators that exist only to drive them (TB4).

**Examples.** OKI MSM6295 · OKI MSM5205 · Konami K007232 · Konami K053260 · Namco C140 · Namco C352 · Sega
315-5218 (Sega PCM) · Yamaha YMZ280B · Ricoh RF5C68.

**Confused with.**

- `sound-wavetable` — §4.13.
- `sound-dac` — a PCM chip contains the sample address/decode path; a `sound-dac` receives a finished stream.
- `sound-speech` — LPC/formant parts synthesize, they do not replay recordings (§4.15).
- `dsp` — §4.3, Q2: a microcoded audio engine (QSound, ES5510) never reaches A2; a fixed-silicon decoder for
  a published format (MAS3507D, MP3) belongs here.

### 4.15 `sound-speech` — Speech synthesis · band `medium`

**Definition.** Speech synthesizers driven by LPC, formant, or allophone parameters.

**Examples.** Texas Instruments TMS5220 · Texas Instruments TMS5100 · Votrax SC-01 · General Instrument
SP0256.

**Confused with.**

- `sound-pcm` — the test is parametric synthesis (a small coefficient stream) versus sample replay (a waveform
  in ROM).
- `sound-psg` — speech parts model a vocal tract, not fixed oscillators.

**Why it exists as a row.** Speech chips are common on early-80s arcade boards and are a genuinely separate HDL
problem (lattice filters and coefficient tables); neither `sound-pcm` nor `sound-psg` describes them honestly.

### 4.16 `sound-dac` — Audio DAC · band `soft`

**Definition.** Digital-to-analog conversion of an audio stream, and nothing else: standalone DACs, R-2R
ladders modelled as a device, and the floating-point DACs sold as FM companions.

**Examples.** Yamaha YM3012 · Yamaha YM3014B · Analog Devices AD7524 · Precision Monolithics DAC-08.

**Confused with.**

- `sound-pcm` — TB7. If the part sequences samples, it is `sound-pcm`.
- `sound-analog` — a DAC converts; an op-amp/filter/amplifier shapes or drives what came out of it.

**Note.** A discrete resistor ladder earns a chip row exactly when MAME models it as a DAC device: the device
carries real instance counts on machine BOMs, and a generic row (`dac-8bit-r2r` and kin) records them honestly
even though no single physical IC exists. A ladder MAME folds into `discrete` or `netlist` gets no row (§4.17
note). The same rule governs the video side (§4.24).

### 4.17 `sound-analog` — Analog audio · band `soft`

**Definition.** Analog and discrete audio circuitry modelled as a BOM part: oscillators/timers used as tone
sources, op-amps, filters, mixers, and audio power amplifiers.

**Examples.** Signetics NE555 (used as a discrete tone source) · Texas Instruments LM324 (quad op-amp) · Texas
Instruments LM358 · STMicroelectronics TDA2003 (audio power amp).

**Confused with.**

- `sound-dac` — §4.16.
- `glue` — the discriminator is whether the part is in the audio path. A 555 generating a coin sound is
  `sound-analog`; a 555 generating a reset pulse is `glue`.

**Note.** MAME's pseudo-devices `discrete`, `netlist`, `speaker` and `screen` are not chips. They MUST take a
`mame_device` row with `ignore_reason` set and `chip_id` NULL, never a `sound-analog` chip.

**Band caveat.** `soft` reflects that these parts are individually small and usually approximated rather than
netlist-simulated. On a pre-1980 board where discrete audio is the entire sound system, the honest signal is
the number of such rows, not the band.

### 4.18 `video-tilemap` — Tilemap generator · band `hard`

**Definition.** Generators of scrolling tile/character background layers from a map plus a character source,
including layers with affine rotate/zoom (ROZ/PSAC) capability.

**Examples.** Konami K052109 · Konami K051316 (PSAC, ROZ) · Konami K053936 (PSAC2, ROZ) · Taito TC0100SCN ·
Taito TC0480SCP.

**Confused with.**

- `video-ppu` — V1: a part that also makes sprites and sync on the same die is `video-ppu`.
- `video-sprite` — tilemaps are screen-aligned and scrolled; sprites are individually positioned objects.
- `video-blitter` — a tilemap generator composes on the fly during scanout; a blitter writes pixels into memory
  ahead of time.

### 4.19 `video-sprite` — Sprite generator · band `hard`

**Definition.** Fetch, position, size, zoom, and line-buffering of movable objects.

**Examples.** Konami K053246/K053247 sprite pair · Konami K051960 · Taito TC0080VCO · SNK LSPC2-A2 (Neo Geo
sprite controller; also emits the fix overlay and sync — §3.1) · Namco C355.

**Confused with.**

- `video-tilemap` / `video-ppu` — §4.18, V1.
- `video-blitter` — sprite chips render per scanline into a line buffer; blitters render into a framebuffer
  under program control.
- `video-mixer` — sprite priority _resolution against other layers_ is `video-mixer`; priority _among sprites_
  is part of the sprite engine.

### 4.20 `video-ppu` — Picture processor / VDP · band `hard`

**Definition.** An integrated video processor that produces a complete picture from one die: tile layers
**and** sprites **and** raster timing, usually with the palette and sometimes the DAC.

**Examples.** Ricoh 2C02 (NES PPU) · Sega 315-5124 (SMS VDP) · Sega 315-5313 (Mega Drive VDP) · Texas
Instruments TMS9918A · Yamaha V9938 · Nintendo S-PPU1/S-PPU2 pair.

**Confused with.**

- `video-tilemap` / `video-sprite` — V1 is the whole test: does one part make the entire picture? A sprite
  engine whose extras are sync and a fixed overlay (LSPC2-A2) fails it — §3.1.
- `custom` — TB3: a VDP's many functions are all `video-*`, so it never reaches TB5.
- `cpu` — TB1 outranks: a CPU die with a PPU bolted on is `cpu`.

### 4.21 `video-blitter` — Blitter / rasterizer · band `hard`

**Definition.** Drawing engines that write pixels into a framebuffer or line buffer from commands or a display
list: bitmap blits with raster ops, polygon/span fillers, line/vector strokers, 3D rasterizers.

**Examples.** Commodore Agnus (Amiga blitter, TB4) · Hitachi HD63484 ACRTC · Atari AVG/DVG vector generators ·
Sega Model 2/3 rasterizer ASICs · TMS34010-family graphics engines when used as a fixed rasterizer (note: as a
programmable processor it is `cpu` under TB1).

**Confused with.**

- `video-tilemap` / `video-sprite` — the discriminator is destination: memory (blitter) versus the scanout path
  (tilemap/sprite).
- `dma` — §4.4.

### 4.22 `video-mixer` — Video mixer / palette · band `hard`

**Definition.** Digital composition of already-generated layers: priority resolution, palette RAM and lookup,
colour arithmetic, shadow/highlight and blending.

**Examples.** Konami K053251 (priority encoder) · Taito TC0360PRI (priority mixer) · Taito TC0110PCR
(palette/priority) · Konami K055555.

**Confused with.**

- `video-dac` — TB7: `video-mixer` is digital in, digital out; `video-dac` produces analog.
- `video-sprite` — §4.19.
- `custom` — a mixer that also gates protection registers has no dominant function (TB5) and becomes `custom`;
  the CPS-B-21 adjudication in §6 is the reference case.

**Why it exists as a row.** Konami and Taito ship discrete priority/palette parts on nearly every board;
without this row they land in `custom` and each one falsely marks a board as unknown rather than merely hard.

### 4.23 `video-crtc` — CRT controller · band `hard`

**Definition.** Raster timing generation without pixel content: H/V sync and blanking, display address
counters, cursor/interlace control.

**Examples.** Motorola MC6845 · Hitachi HD46505 · Intel 8275 · Konami K053252 (video timing generator).

**Confused with.**

- `video-ppu` — a CRTC generates no pixels; character/attribute fetch and shifting are external.
- `timer` — §4.9.
- `video-tilemap` — a CRTC emits addresses; a tilemap generator emits pixels.

**Band.** `hard` — the parts are simple, but the video pipeline they clock is where an arcade port's timing
accuracy is won or lost, and a wrong CRTC breaks everything downstream of it.

### 4.24 `video-dac` — Video DAC / encoder · band `soft`

**Definition.** Conversion of digital pixel data to analog video, and analog video encoding: RAMDACs, palette
DACs, RGB-to-composite/S-video/component encoders, sync/video amplifiers.

**Examples.** Brooktree Bt458 · Brooktree Bt471 · Sony CXA1145 (video encoder) · Sega 315-5242 (colour
encoder/palette DAC).

**Confused with.**

- `video-mixer` — §4.22, TB7.
- `glue` — an encoder IC is always a chip. A discrete resistor ladder follows §4.16's rule: a chip row when
  MAME models it as a device, no row when it is buried in a schematic MAME never modelled.

**Band.** `soft`, and deliberately the one `video-*` row that is: an FPGA platform replaces the output stage
with its own rather than reimplementing the part. This is why the band is a column read per row and MUST NOT
be inferred from the `video-` prefix.

### 4.25 `custom` — Custom ASIC · band `hard`

**Definition.** A board-specific ASIC that spans two or more top-level categories with no dominant one (TB5).
**Not** a bucket for undocumented parts (TB8) and **not** a synonym for "Sega/Konami/Namco part number".

**Examples.** Capcom CPS-B-21 (video mixing + sprite control + per-game protection registers) · Data East 146
(protection + I/O + interrupt) · Sega SCU (DMA + DSP + interrupt control).

**Confused with.**

- an unmapped MAME device — TB8. Unknown function ⇒ no `chip` row; the device shows up in
  `machine_unmapped_device` and `v_mame_device_worklist`.
- `protection`, `video-mixer`, `dsp` — each of these wins whenever it dominates. Reaching `custom` means you
  have argued that none does.
- `cpu` — TB1 always wins.

**Curation expectation.** `custom` should shrink over time as parts are documented. A rising `custom` count is
a curation smell and is a one-line `GROUP BY function_id` query, not a stored metric.

### 4.26 `glue` — Glue logic · band `soft`

**Definition.** Catalog logic with no system-level identity: 74-series gates/latches/buffers/counters, PAL/GAL/
PROM decoders, line drivers, comparators, clock generators and dividers, reset supervisors, level shifters.

**Examples.** 74LS374 (octal latch) · 74LS245 (bus transceiver) · AMD PAL16L8 · Lattice GAL16V8 · Texas
Instruments 74LS157.

**Confused with.**

- `io` — §4.10: registers and programmability mean `io`.
- `memory` — §4.5: a decode PAL is `glue`; a programmable mapper is `memory`.
- `sound-analog` — §4.17: position in the audio path decides.

**Note.** Most glue never reaches the dataset — MAME does not model it as devices, and BOM Squad does not chase
it. Rows exist mainly for PALs whose contents matter and for parts a curated `system_chip` row adds
deliberately.

---

## 5. `prospector_band`

`chip_function.prospector_band TEXT NOT NULL CHECK (prospector_band IN ('hard','medium','soft'))`.

It is a **domain classification of the function**, not a score: how likely a missing implementation of a chip
of this function is to block an FPGA port. The Prospector reads it from the table by join — `v_chip_gap`
exposes it per gap chip, and any weighting SQL joins `chip → chip_function`. The numeric weight per band, if
one is ever used, lives in `pipeline/config/`, so retuning never touches this table and never touches code.

| Band     | Rows                                                                                                                      | Rationale                                                                                                                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hard`   | `custom`, `dsp`, `protection`, `video-blitter`, `video-crtc`, `video-mixer`, `video-ppu`, `video-sprite`, `video-tilemap` | Undocumented, board-specific, or reverse-engineering-bound. The video pipeline is the largest single share of a typical arcade port's effort; protection and custom parts often have no public docs. |
| `medium` | `cpu`, `mcu`, `sound-fm`, `sound-pcm`, `sound-psg`, `sound-speech`, `sound-wavetable`, `storage`                          | Well-documented behaviour; open cores frequently exist or port cleanly.                                                                                                                              |
| `soft`   | `dma`, `glue`, `io`, `memory`, `rtc`, `sound-analog`, `sound-dac`, `timer`, `video-dac`                                   | Small, documented, or replaced outright by the FPGA platform's own I/O and output stages.                                                                                                            |

Two rules that follow from the column being per-row:

- **Band by row, never by branch prefix.** `video-dac` is `soft` while every other `video-*` row is `hard`.
  SQL that does `WHERE function_id LIKE 'video-%'` to infer difficulty is a bug.
- **Unmapped devices are not zero risk.** They have no `chip` row and therefore no band at all. The Prospector
  carries them as `v_system_coverage.unmapped_device_count`, which the ranking sorts ascending — a system with
  unmapped devices is less trustworthy than one without, whatever its band mix.

**The band is a property of the function, not of the part.** `prospector_band` rides the `chip_function` row,
so every chip inherits its function's band — and a correct classification can carry a misleading difficulty
signal, in both directions. An HD44780 character-LCD controller is honestly `video-tilemap` (band `hard`) yet
is trivial in HDL; the Yamaha AICA is `cpu` by TB1 (band `medium`) yet carries a 64-voice sample engine and an
effects DSP that are anything but. Do not bend a classification to repair its band — the function value MUST
stay honest, and §6 binds the parts it names. The one legitimate reach for `custom` is TB5 taken at face
value: when a board-specific ASIC genuinely spans branches with no dominant function, file it `custom` (band
`hard`) rather than crowning a "dominant" function whose band understates the part. The Prospector's weighting
(T6.3) MUST treat the band as a prior over the function, never as a per-part measurement, and SHOULD
corroborate it with per-part signals — known implementations, documentation — before ranking on it. If such
mislabels accumulate, the right long-term fix is an optional per-chip difficulty override on `chip`; that is a
schema change, recorded here as a recommendation and deliberately not made.

Changing a row's band is a data change: edit `data/lookup/chip_function.json` and the table above in the same
PR.

---

## 6. Worked adjudications

Reference decisions. These are normative for the parts named; contributors MUST NOT relitigate them per-board.

| Part                         | Competing values                               | Value           | Rule                                                          |
| ---------------------------- | ---------------------------------------------- | --------------- | ------------------------------------------------------------- |
| Ricoh 2A03                   | `cpu` / `sound-psg`                            | `cpu`           | TB1 — 6502 core executes the game                             |
| Hudson HuC6280               | `cpu` / `sound-wavetable` / `memory`           | `cpu`           | TB1                                                           |
| Ricoh 5A22                   | `cpu` / `dma`                                  | `cpu`           | TB1                                                           |
| Taito TC0090LVC              | `cpu` / `custom`                               | `cpu`           | TB1 outranks TB5                                              |
| Sega FD1094                  | `cpu` / `protection`                           | `cpu`           | TB1, TB6 — an encrypted 68000 is a 68000                      |
| Yamaha AICA                  | `cpu` / `sound-pcm` / `dsp`                    | `cpu`           | TB1 — the ARM7 core absorbs the sound engine (band: §5)       |
| Dallas DS5002FP              | `mcu` / `protection`                           | `mcu`           | TB6 — catalog part, secure variant                            |
| Nintendo CIC                 | `protection` / `mcu`                           | `protection`    | TB6 — lockout is the entire purpose                           |
| Yamaha YM2610                | `sound-fm` / `sound-pcm` / `sound-psg`         | `sound-fm`      | TB3 — one branch, FM defines it                               |
| Yamaha YM2413                | `sound-fm` / `sound-wavetable`                 | `sound-fm`      | TB3 — the instrument ROM holds FM parameters, not waveforms   |
| Yamaha YM3012                | `sound-fm` / `sound-dac`                       | `sound-dac`     | TB7 — separate die, conversion only                           |
| Capcom QSound (DL-1425)      | `dsp` / `sound-pcm`                            | `dsp`           | Q2 — the algorithm is mask microcode, not a published format  |
| Micronas MAS3507D            | `sound-pcm` / `dsp`                            | `sound-pcm`     | A2 — fixed-silicon decoder for a published format (MP3)       |
| Sega 315-5313                | `video-ppu` / `video-tilemap` / `video-sprite` | `video-ppu`     | TB3, V1 — one die makes the whole picture                     |
| Sega 315-5124                | `video-ppu` / `sound-psg`                      | `video-ppu`     | TB3 — the PSG section rides along; the VDP is the part        |
| SNK LSPC2-A2                 | `video-sprite` / `video-ppu`                   | `video-sprite`  | TB3 — sprites define it; a fix overlay is not a V1 tile layer |
| Commodore Agnus              | `video-blitter` / `dma` / `video-crtc`         | `video-blitter` | TB4 — DMA and timing serve the display                        |
| Capcom CPS-B-21              | `video-mixer` / `protection` / `custom`        | `custom`        | TB5 — per-game keying makes video and protection inseparable  |
| MOS 8364 "Paula"             | `custom` / `sound-pcm` / `storage` / `io`      | `custom`        | TB5 — audio, floppy and serial with no dominant branch        |
| Atari POKEY                  | `sound-psg` / `io` / `custom`                  | `sound-psg`     | TB5 inapplicable — catalog part; Q5 fires first               |
| Konami K051316               | `video-tilemap` / `video-blitter`              | `video-tilemap` | V3 — an affine tile layer is still a tile layer               |
| Hitachi HD44780              | `video-tilemap` / `video-crtc` / `io`          | `video-tilemap` | V3 — character layer from map + CG ROM (band: §5)             |
| Motorola MC6845              | `video-crtc` / `video-ppu` / `timer`           | `video-crtc`    | V6 — timing only, no pixels                                   |
| Intel 8259A                  | `io` / `timer`                                 | `io`            | Q11 — no `interrupt` row exists (§4.10)                       |
| Motorola MC68901             | `io` / `timer`                                 | `io`            | §4.9 — multifunction peripherals resolve to `io`              |
| SGS-Thomson M48T58           | `rtc` / `memory`                               | `rtc`           | §4.8 — the clock is the reason for the part                   |
| Signetics NE555 (coin sound) | `sound-analog` / `glue`                        | `sound-analog`  | §4.17 — in the audio path                                     |
| Nintendo MMC3                | `memory` / `custom`                            | `memory`        | Q8 — a documented mapper                                      |

A part in this table that later needs reclassifying is a data change to its `chip` row plus an edit to this
row; the FK to `chip_function` guarantees the new value exists.

---

## 7. Change control

- **Adding a row** requires, in one PR: a row in `data/lookup/chip_function.json` (slug-grammar `function_id`,
  `label`, one-line `description`, a `prospector_band`); a §4 section with a definition, ≥3 real example parts,
  and neighbour discriminators; a decision-guide question placed at the right precedence; and a line in the §5
  band table. No schema change and no code change — that is what makes the lookup table the right structure.
- **Removing a row** requires re-pointing every `chip.function_id` that references it in the same PR. The FK is
  `ON DELETE RESTRICT`, so an incomplete migration fails the build rather than orphaning chips.
- **Renaming a row** is a delete plus an insert under §3.3 stability rules. `chip_function` has no alias table;
  it is not a URL-addressable entity.
- **Reclassifying a single chip** is a data change to that chip's file, not a spec change, unless it
  contradicts §6.
- Examples in this document assert real parts. Standing rule 3 applies: a part MUST be omitted rather than
  guessed at.

---

## 8. Seed data

The complete table is [`data/lookup/chip_function.json`](../data/lookup/chip_function.json): one top-level key
`chip_function`, 26 flat rows, keys in DDL column order (`function_id`, `label`, `description`,
`prospector_band`), rows sorted bytewise by `function_id`, per data-model §4.3.

The 26 `function_id` values in that order:

```
cpu · custom · dma · dsp · glue · io · mcu · memory · protection · rtc ·
sound-analog · sound-dac · sound-fm · sound-pcm · sound-psg · sound-speech · sound-wavetable ·
storage · timer ·
video-blitter · video-crtc · video-dac · video-mixer · video-ppu · video-sprite · video-tilemap
```
