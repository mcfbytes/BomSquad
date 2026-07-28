/**
 * The MAME driver `.cpp` witness — the Guru PCB notes MAME's own `-listxml` throws away.
 *
 * ## Why this is a second witness at all
 *
 * It reads the same repository the extraction is already pinned to, which sounds like
 * asking one source to disagree with itself. It is not, and the reason is structural.
 * MAME's XML describes the *emulation*: a `<chip>` or `<device_ref>` element exists when
 * MAME instantiates a C++ device model. The comments at the top of a driver, and above each
 * `ROM_START`, describe the *board* — transcribed from photographs of real PCBs, part by
 * part, package by package:
 *
 * ```text
 *   315-5195 - Custom Sega IC (PGA135)
 *   315-5196 - Custom Sega IC Sprite Generator (PGA135)
 *   315-5197 - Custom Sega IC Tilemap Generator (PGA135)
 * ```
 *
 * ```text
 *   Custom chip -   CAPCOM CPS-B-01 (QFP160)
 * ```
 *
 * Those two facts are produced by different people for different purposes, and the second
 * is exactly the board-level part list the first omits. Capcom's CPS-A and CPS-B are the
 * case that proves it: MAME implements both inside `capcom/cps1.cpp` as driver code, so
 * they are in no `<device_ref>`, no `machine_chip` row, and no `machine_unmapped_device`
 * row — yet the driver's own comments name them. No amount of re-reading the XML finds
 * that. Reading the comments does.
 *
 * ## Comments only
 *
 * The scan runs over comment text with string and character literals removed. A
 * `ROM_LOAD("315-5298.b9", ...)` line names a PLD *dump*, not a socket, and admitting code
 * would flood the report with ROM labels. Stripping literals also means a device tag such
 * as `"maincpu"` can never be mistaken for prose.
 *
 * ## Attribution
 *
 * A comment block immediately above a `ROM_START(<machine>)` belongs to that machine, and
 * therefore to whichever system that machine resolves to — `machine_system` overrides
 * included, so a Guru note above `airduel` lands on `irem-m82` and not on `irem-m72` just
 * because it lives in `irem/m72.cpp`. This is where the interesting parts are: on
 * `capcom/cps1.cpp` the per-`ROM_START` blocks name the B-board customs one board revision
 * at a time.
 *
 * Everything else is a *file-level* comment, and those go to the systems the file
 * **declares** through a `system_driver` row — not to every system its machines happen to
 * reach. A driver header describes the board the driver is named for, and one
 * `machine_system` override is enough to make a file "reach" a second, quite different
 * board: `capcom/cps1.cpp` reaches `capcom-cps1-5` that way, and attributing the CPS-1
 * header's YM2151 and MSM6295 to a Q-Sound board that has neither would be a manufactured
 * disagreement. Where a file declares nothing at all, its resolved systems are used, since
 * the alternative is discarding the header entirely.
 */
import { compareBytes } from '../db/rowfiles.js';
import { resolvePart, scanParts, type ChipIndex } from './parts.js';
import { collapseParts, type WitnessPart, type WitnessRecord } from './witness.js';
import type { MameSourceConfig, RecognitionConfig } from './config.js';
import type { ReconcileFetcher } from './http.js';

/** A run of comment text, with the line it starts on and what it is attached to. */
export interface CommentBlock {
  readonly text: string;
  /** 1-based line of the first character of the block. */
  readonly line: number;
  /** The `ROM_START` this block sits immediately above, if any. */
  readonly machineId?: string;
}

/**
 * Splits a C++ translation unit into comment blocks, tracking string and character
 * literals so a `//` inside `"http://…"` is not a comment and a `"` inside a comment does
 * not open a literal.
 *
 * Adjacent comment lines are one block: a Guru note is a paragraph of `//` lines or one
 * `/* … *\/`, and treating each line separately would lose the context word that a
 * `requires_context` pattern needs on the same *line* — but not the block-level structure
 * this returns for attribution.
 */
export function extractComments(source: string): CommentBlock[] {
  const blocks: CommentBlock[] = [];
  const newlines = (text: string): number => {
    let count = 0;
    for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) {
      count += 1;
    }
    return count;
  };

  let index = 0;
  let line = 1;
  /** Text of the block being accumulated, the line it starts on, the line it ends on. */
  let pending = '';
  let pendingLine = 0;
  let pendingEndLine = 0;
  /** Character offset just past the previous comment, to detect adjacency. */
  let pendingEnd = -1;

  const flush = (): void => {
    if (pending !== '') blocks.push({ text: pending, line: pendingLine });
    pending = '';
    pendingLine = 0;
  };

  /**
   * Adds one comment's text to the pending block, or starts a new one. When it joins, the
   * join is padded with the newlines that actually separate the two in the file, so that
   * `block.line + hitLine - 1` stays the real line number and every citation URL points at
   * the line a reader will see.
   */
  const absorb = (text: string, startLine: number, adjacent: boolean): void => {
    if (pending !== '' && adjacent) {
      const gap = startLine - pendingEndLine;
      pending += (gap > 0 ? '\n'.repeat(gap) : ' ') + text;
    } else {
      flush();
      pending = text;
      pendingLine = startLine;
    }
    pendingEndLine = startLine + newlines(text);
  };

  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];

    if (character === '\n') {
      line += 1;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      const quote = character;
      index += 1;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === '\\') index += 1;
        else if (source[index] === '\n') line += 1;
        index += 1;
      }
      index += 1;
      continue;
    }
    if (character === '/' && (next === '/' || next === '*')) {
      const lineComment = next === '/';
      const end = lineComment ? source.indexOf('\n', index) : source.indexOf('*/', index + 2);
      const textEnd = end < 0 ? source.length : end;
      const stop = lineComment || end < 0 ? textEnd : end + 2;
      const text = source.slice(index + 2, textEnd);
      // Only whitespace between two comments keeps them in one block.
      absorb(text, line, pending !== '' && /^\s*$/.test(source.slice(pendingEnd, index)));
      pendingEnd = stop;
      line += newlines(source.slice(index, stop));
      index = stop;
      continue;
    }
    index += 1;
  }
  flush();
  return blocks;
}

const ROM_START = /\bROM_START\s*\(\s*([A-Za-z0-9_]+)\s*\)/g;

/** Line number of every character offset, as a sorted table of line-start offsets. */
function lineStarts(source: string): number[] {
  const starts = [0];
  for (let index = source.indexOf('\n'); index >= 0; index = source.indexOf('\n', index + 1)) {
    starts.push(index + 1);
  }
  return starts;
}

/** 1-based line containing `offset`, by binary search over {@link lineStarts}. */
function lineAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((starts[middle] ?? 0) <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

/**
 * Attaches each comment block to the `ROM_START` it precedes, when only whitespace and
 * other comments separate the two.
 *
 * "Immediately above" means within three lines, which is the shape `capcom/cps1.cpp`
 * actually uses: a Guru block naming the B-board and its customs, then a one-line note
 * about how the ROMs are labelled, then `ROM_START`.
 */
export function attachRomStarts(source: string, blocks: readonly CommentBlock[]): CommentBlock[] {
  const starts = lineStarts(source);
  const ends = blocks
    .map((block, position) => ({
      position,
      endLine: block.line + block.text.split('\n').length - 1,
    }))
    .sort((a, b) => a.endLine - b.endLine || a.position - b.position);

  const attached = new Map<number, string>();
  ROM_START.lastIndex = 0;
  for (const match of source.matchAll(ROM_START)) {
    const machineId = match[1];
    if (machineId === undefined) continue;
    const startLine = lineAt(starts, match.index);
    // The last block ending strictly above this ROM_START, by binary search.
    let low = 0;
    let high = ends.length - 1;
    let found = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const candidate = ends[middle];
      if (candidate !== undefined && candidate.endLine < startLine) {
        found = middle;
        low = middle + 1;
      } else high = middle - 1;
    }
    const best = found < 0 ? undefined : ends[found];
    if (best !== undefined && startLine - best.endLine <= 3) attached.set(best.position, machineId);
  }
  return blocks.map((block, position) => {
    const machineId = attached.get(position);
    return machineId === undefined ? block : { ...block, machineId };
  });
}

/** `capcom/cps1.cpp` -> the raw URL to fetch and the blob URL to cite. */
export function driverUrls(
  sourcefile: string,
  release: string,
  config: MameSourceConfig,
): { readonly raw: string; readonly blob: string } {
  return {
    raw: `${config.rawBaseUrl}/${release}/${config.sourceRoot}/${sourcefile}`,
    blob: `${config.blobBaseUrl}/${release}/${config.sourceRoot}/${sourcefile}`,
  };
}

/**
 * Turns one driver's text into `system_id -> parts`.
 *
 * `systemsForFile` is every system whose `system_driver` row names this file;
 * `systemOfMachine` resolves a `ROM_START` name to the system that machine actually belongs
 * to, which is what makes a per-`ROM_START` Guru note land on `irem-m82` rather than on
 * `irem-m72` just because it lives in `irem/m72.cpp`.
 */
export function partsFromDriver(
  source: string,
  sourcefile: string,
  blobUrl: string,
  systemsForFile: readonly string[],
  systemOfMachine: ReadonlyMap<string, string>,
  recognition: RecognitionConfig,
  index: ChipIndex,
): Map<string, WitnessPart[]> {
  const perSystem = new Map<string, WitnessPart[]>();
  const add = (systemId: string, part: WitnessPart): void => {
    const bucket = perSystem.get(systemId) ?? [];
    bucket.push(part);
    perSystem.set(systemId, bucket);
  };

  for (const block of attachRomStarts(source, extractComments(source))) {
    const targets =
      block.machineId === undefined
        ? systemsForFile
        : // A ROM_START whose machine is not in the extract (filtered out as a clone, a
          // gambling driver, or a mechanical cabinet) tells us nothing about a system.
          [systemOfMachine.get(block.machineId)].filter((id): id is string => id !== undefined);
    if (targets.length === 0) continue;

    for (const hit of scanParts(block.text, recognition, index)) {
      const resolved = resolvePart(hit.designation, index, recognition);
      if (resolved === undefined) continue;
      const line = block.line + hit.line - 1;
      const part: WitnessPart = {
        key: resolved.key,
        designation: resolved.designation,
        ...(resolved.chipId !== undefined ? { chip_id: resolved.chipId } : {}),
        source_url: `${blobUrl}#L${line}`,
        evidence:
          block.machineId === undefined
            ? `${sourcefile}: ${hit.evidence}`
            : `${sourcefile} (${block.machineId}): ${hit.evidence}`,
      };
      for (const systemId of targets) add(systemId, part);
    }
  }
  return perSystem;
}

/**
 * Fetches every driver source file the dataset's systems reach and returns the witness.
 *
 * One request per *file*, not per system: `toaplan-version2` alone spans twelve drivers and
 * `sega/segas16b.cpp` speaks for two systems, so a per-system loop would fetch the same
 * megabyte twice and hit a rate limiter for no reason.
 */
export async function mameSourceWitness(
  fetcher: ReconcileFetcher,
  config: MameSourceConfig,
  release: string,
  sourcefilesBySystem: ReadonlyMap<string, readonly string[]>,
  declaredSystemsBySourcefile: ReadonlyMap<string, readonly string[]>,
  systemOfMachine: ReadonlyMap<string, string>,
  recognition: RecognitionConfig,
  index: ChipIndex,
  log: (line: string) => void,
): Promise<ReadonlyMap<string, WitnessRecord>> {
  /** Every file worth fetching: one a system's machines came from, or one it declares. */
  const reachedByFile = new Map<string, string[]>();
  for (const [systemId, files] of sourcefilesBySystem) {
    for (const file of files) {
      const bucket = reachedByFile.get(file) ?? [];
      bucket.push(systemId);
      reachedByFile.set(file, bucket);
    }
  }
  for (const file of declaredSystemsBySourcefile.keys()) {
    if (!reachedByFile.has(file)) reachedByFile.set(file, []);
  }

  const collected = new Map<string, WitnessPart[]>();
  for (const sourcefile of [...reachedByFile.keys()].sort(compareBytes)) {
    const urls = driverUrls(sourcefile, release, config);
    const response = await fetcher.fetch(urls.raw);
    if (response.status !== 200) {
      log(`reconcile: mame-source: ${sourcefile} returned HTTP ${response.status}; skipped`);
      continue;
    }
    const declared = declaredSystemsBySourcefile.get(sourcefile) ?? [];
    const targets = [
      ...(declared.length > 0 ? declared : (reachedByFile.get(sourcefile) ?? [])),
    ].sort(compareBytes);
    const perSystem = partsFromDriver(
      response.body,
      sourcefile,
      urls.blob,
      targets,
      systemOfMachine,
      recognition,
      index,
    );
    for (const [systemId, parts] of perSystem) {
      collected.set(systemId, [...(collected.get(systemId) ?? []), ...parts]);
    }
  }

  const witnesses = new Map<string, WitnessRecord>();
  for (const [systemId, parts] of collected) {
    const record = collapseParts('mame-source', parts);
    if (record !== undefined) witnesses.set(systemId, record);
  }
  return witnesses;
}
