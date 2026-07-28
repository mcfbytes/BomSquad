/**
 * The jotego/jtcores witness — GPL, a public repository, and the only one of the four that
 * is a *reimplementation* rather than a description.
 *
 * ## Why an FPGA core is a witness
 *
 * Someone who writes a compatible core has to decide, part by part, what is on the board:
 * a Verilog file that instantiates `jt51` and `jt6295` is an assertion that the board has a
 * YM2151 and an MSM6295, made by someone who had the PCB on the bench. jtcores' own README
 * for `s16b` says the core "was developed with the help of a SEGA System 16B model 171-5358
 * board lent by FunkyCochise". That is a different kind of evidence from a wiki edit.
 *
 * ## Two files per core, and what each is worth
 *
 * - `cfg/files.yaml` and `cfg/common.yaml` list the *repositories* a core depends on
 *   (`jt51:`, `jt6295:`, `jt7759:`). Cheap and reliable, but coarse: `jt12:` names a
 *   repository that contains YM2203, YM2612, AY-3-8910 and SN76489 cores, so it says
 *   nothing about which one this board has. Only modules `config/reconcile-systems.json`
 *   maps to a specific part are admitted, and `jt12` deliberately has no mapping.
 * - `hdl/*_game.v`, `_main.v`, `_snd.v`, `_sound.v` carry the actual instantiations, which
 *   *are* specific.
 *
 * ## What it will never say
 *
 * A core reimplements a board's *behaviour*, so it has a module where the board has a
 * custom chip and no module at all where the board has glue. jtcores will not tell you a
 * System 16B has a 315-5195; it will tell you it has a YM2151, a uPD7759 and an FD1094.
 * Treated as a complete BOM it would be badly wrong, which is why it is one witness of
 * several and why `report.ts` never lets a single witness's silence mean anything.
 */
import { compareBytes } from '../db/rowfiles.js';
import { resolvePart, type ChipIndex } from './parts.js';
import { collapseParts, type WitnessPart, type WitnessRecord } from './witness.js';
import type { JtcoresConfig, JtModule, RecognitionConfig, SystemBinding } from './config.js';
import type { ReconcileFetcher } from './http.js';

/** A Verilog instantiation: `jt51 u_jt51(` or `jtframe_z80_romwait u_cpu(`. */
const INSTANTIATION =
  /^[ \t]*([A-Za-z][A-Za-z0-9_]*)\s*(?:#\s*\([^;]*?\)\s*)?[A-Za-z_][A-Za-z0-9_]*\s*\(/gm;

/** A top-level YAML key: `jt51:` in a `files.yaml` dependency list. */
const YAML_KEY = /^([A-Za-z][A-Za-z0-9_]*):/gm;

/** Every module name one file asserts, with the line each was found on. */
export function modulesInFile(
  text: string,
  kind: 'verilog' | 'yaml',
): readonly { readonly module: string; readonly line: number; readonly evidence: string }[] {
  const pattern = kind === 'verilog' ? INSTANTIATION : YAML_KEY;
  const found: { module: string; line: number; evidence: string }[] = [];
  const starts: number[] = [0];
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) {
    starts.push(index + 1);
  }
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const module = match[1];
    if (module === undefined) continue;
    let line = 1;
    for (let position = 1; position < starts.length; position += 1) {
      if ((starts[position] ?? 0) <= match.index) line = position + 1;
      else break;
    }
    found.push({
      module,
      line,
      evidence: (text.split('\n')[line - 1] ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
    });
  }
  return found;
}

/** The recursive tree listing for the pinned commit: `path` entries only. */
export function parseTreePaths(body: string): readonly string[] {
  let document: unknown;
  try {
    document = JSON.parse(body);
  } catch {
    return [];
  }
  const tree = (document as { tree?: unknown } | null)?.tree;
  if (!Array.isArray(tree)) return [];
  const paths: string[] = [];
  for (const entry of tree as Record<string, unknown>[]) {
    const path = entry['path'];
    if (typeof path === 'string') paths.push(path);
  }
  return paths.sort(compareBytes);
}

/** Which files under `cores/<core>/` this witness reads, bytewise sorted. */
export function filesForCore(
  paths: readonly string[],
  core: string,
  config: JtcoresConfig,
): readonly string[] {
  const prefix = `cores/${core}/`;
  const wanted = paths.filter((path) => {
    if (!path.startsWith(prefix)) return false;
    if (config.configFiles.some((file) => path === `${prefix}${file}`)) return true;
    return (
      path.startsWith(`${prefix}hdl/`) && config.hdlSuffixes.some((suffix) => path.endsWith(suffix))
    );
  });
  return [...wanted].sort(compareBytes);
}

export async function jtcoresWitness(
  fetcher: ReconcileFetcher,
  config: JtcoresConfig,
  jtModules: readonly JtModule[],
  bindings: readonly SystemBinding[],
  recognition: RecognitionConfig,
  index: ChipIndex,
  log: (line: string) => void,
): Promise<ReadonlyMap<string, WitnessRecord>> {
  const cores = [...new Set(bindings.flatMap((binding) => binding.jtcores))].sort(compareBytes);
  if (cores.length === 0) return new Map();

  const tree = await fetcher.fetch(`${config.treeApiUrl}/${config.commit}?recursive=1`, {
    accept: 'application/vnd.github+json',
  });
  if (tree.status !== 200) {
    log(`reconcile: jtcores: tree API returned HTTP ${tree.status}; witness skipped`);
    return new Map();
  }
  const paths = parseTreePaths(tree.body);
  const known = new Map(jtModules.map((entry) => [entry.module, entry]));

  /** core -> the parts its files assert. */
  const perCore = new Map<string, WitnessPart[]>();
  for (const core of cores) {
    const files = filesForCore(paths, core, config);
    if (files.length === 0) {
      log(`reconcile: jtcores: no files under cores/${core}/ at the pinned commit`);
      continue;
    }
    for (const path of files) {
      const response = await fetcher.fetch(`${config.rawBaseUrl}/${config.commit}/${path}`);
      if (response.status !== 200) {
        log(`reconcile: jtcores: ${path} returned HTTP ${response.status}; skipped`);
        continue;
      }
      const kind = path.endsWith('.v') ? 'verilog' : 'yaml';
      for (const found of modulesInFile(response.body, kind)) {
        const mapping = known.get(found.module);
        if (mapping === undefined) continue;
        const resolved = resolvePart(mapping.part, index, recognition);
        if (resolved === undefined) continue;
        perCore.set(core, [
          ...(perCore.get(core) ?? []),
          {
            key: resolved.key,
            designation: resolved.designation,
            ...(resolved.chipId !== undefined ? { chip_id: resolved.chipId } : {}),
            source_url: `${config.blobBaseUrl}/${config.commit}/${path}#L${found.line}`,
            evidence: `${path}: ${found.module} -> ${mapping.part} (${mapping.note})`,
          },
        ]);
      }
    }
  }

  const witnesses = new Map<string, WitnessRecord>();
  for (const binding of bindings) {
    const parts = binding.jtcores.flatMap((core) => perCore.get(core) ?? []);
    const record = collapseParts('jtcores', parts);
    if (record !== undefined) witnesses.set(binding.systemId, record);
  }
  return witnesses;
}
