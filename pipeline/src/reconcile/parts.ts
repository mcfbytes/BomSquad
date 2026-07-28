/**
 * Part designations: normalising them, resolving them against the curated chip catalogue,
 * and finding them in free text.
 *
 * ## Why a key space at all
 *
 * The two halves of this reconciliation speak different languages. MAME's `-listxml` half
 * arrives already resolved — `machine_chip.chip_id` is a curated `chip` row. Every other
 * witness arrives as *prose*: `315-5197 - Custom Sega IC Tilemap Generator (PGA135)`,
 * `| cpu = [[Motorola 68000]]`, `jt6295 u_adpcm(`. Comparing those directly against
 * `chip_id`s would only ever find the parts a curator had already catalogued, which is
 * precisely the class of finding this task does *not* need.
 *
 * So both sides are projected onto one key space:
 *
 * - `chip:<chip_id>` when the designation resolves to a row in `data/chip/`;
 * - `part:<NORMALISED>` when it does not.
 *
 * The second case is the whole point. A reference witness naming a part with no `chip` row
 * and no MAME device produces a `part:` key that the MAME side cannot possibly carry, and
 * that is a `reference-only` finding — a curation prompt with a citation attached. Capcom's
 * CPS-A and CPS-B are the worked example: MAME models both inside `capcom/cps1.cpp` driver
 * code rather than as devices, so they appear in neither `machine_chip` *nor*
 * `machine_unmapped_device`, and CPS-1 scores as better covered than it is. The driver's own
 * Guru notes name them.
 *
 * ## Normalisation
 *
 * Uppercase, `µ`/`μ` folded to `U` (MAME's ASCII PCB diagrams write `uPD7759`, the chip
 * catalogue writes `µPD7759`, and they are the same part), everything that is not A-Z0-9
 * dropped, then a known manufacturer word stripped from the front. That last step is what
 * makes the catalogue's `Sega 315-5296` and a driver comment's bare `315-5296` the same key,
 * and it is why {@link ReconcileConfig} sorts `vendor_prefixes` longest-first.
 *
 * Normalisation is deliberately lossy and deliberately *not* clever: it will not turn
 * `Z84C0006` into `Z80`, and it should not. What it cannot reach is stated explicitly in
 * `recognition.part_aliases`, where each entry is reviewable.
 *
 * ## Ambiguity
 *
 * If two catalogue chips normalise to one key, neither wins: the key resolves to nothing
 * and every witness that produced it reports an unresolved `part:` finding. Guessing which
 * of two chips a reference meant is exactly the "no guessed facts" failure standing rule 3
 * exists to prevent, and an unresolved finding still reaches a curator with its citation.
 */
import { compareBytes, type Row } from '../db/rowfiles.js';
import type { RecognitionConfig } from './config.js';

/** A designation reduced to its comparison form. */
export function normalizePart(designation: string): string {
  return designation
    .replace(/[µμ]/g, 'U')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/** {@link normalizePart}, then a leading manufacturer word removed if one is there. */
export function normalizeWithoutVendor(
  designation: string,
  vendorPrefixes: readonly string[],
): string {
  const normalized = normalizePart(designation);
  for (const prefix of vendorPrefixes) {
    const rest = normalized.slice(prefix.length);
    // A prefix that swallows the whole designation is the manufacturer's own name, not a
    // part number wearing it: `SEGA` must stay `SEGA`, never become the empty key.
    if (normalized.startsWith(prefix) && rest.length >= 2) return rest;
  }
  return normalized;
}

/** `chip:<id>` for a catalogued part, `part:<NORMALISED>` for one nobody has catalogued. */
export function partKey(chipId: string | undefined, normalized: string): string {
  return chipId === undefined ? `part:${normalized}` : `chip:${chipId}`;
}

/** Resolution of a designation against the catalogue. */
export interface ResolvedPart {
  /** The designation exactly as the witness wrote it. */
  readonly designation: string;
  /** Comparison key, from {@link partKey}. */
  readonly key: string;
  /** Normalised, vendor-stripped form. Present whether or not the catalogue knows it. */
  readonly normalized: string;
  /** Set only when the catalogue resolves it unambiguously. */
  readonly chipId?: string;
}

/**
 * The catalogue, indexed for both directions: normalised key -> `chip_id`, and a search
 * alternation for finding catalogue names in free text.
 */
export interface ChipIndex {
  /** Normalised, vendor-stripped designation -> `chip_id`. Ambiguous keys are absent. */
  readonly byKey: ReadonlyMap<string, string>;
  /** Keys two or more chips claimed, so a caller can say *why* a resolution failed. */
  readonly ambiguous: ReadonlySet<string>;
  /** One regex matching any catalogue name, punctuation-tolerant. `undefined` if empty. */
  readonly literals: RegExp | undefined;
}

/** `AY-3-8910` also matches `AY38910` and `AY 3 8910`; nothing else changes. */
function literalPattern(name: string): string {
  return name
    .split(/[^A-Za-z0-9µμ]+/)
    .filter((piece) => piece !== '')
    .map((piece) => piece.replace(/[µμ]/g, '[uµμ]'))
    .join('[^A-Za-z0-9]?');
}

/**
 * Every searchable form of one catalogue name.
 *
 * `SH-2 (SH7604)` is two names, not one: a witness writes either, and the parenthesised
 * form is usually the part number while the bare one is the family. Splitting here rather
 * than asking curators to write two `chip_name` rows keeps `data/chip/` unchanged.
 */
function nameForms(name: string): string[] {
  const forms = [name];
  const parenthesised = /^([^(]+?)\s*\(([^)]+)\)\s*$/.exec(name);
  if (parenthesised?.[1] !== undefined && parenthesised[2] !== undefined) {
    forms.push(parenthesised[1], parenthesised[2]);
  }
  return forms;
}

/**
 * Builds the index from already-parsed `chip` and `chip_name` rows — i.e. what
 * `readRowFile` over `data/chip/*.json` produces. No I/O, and no knowledge of `data/`'s
 * layout, so this file's tests never have to touch the real catalogue.
 *
 * `partAliases` is applied last and wins: it is the curator's explicit statement that some
 * designation normalisation cannot reach names a given chip.
 */
export function buildChipIndex(
  chips: readonly Row[],
  chipNames: readonly Row[],
  recognition: RecognitionConfig,
): ChipIndex {
  /** key -> the chip ids claiming it, so a second claimant makes the key ambiguous. */
  const claims = new Map<string, Set<string>>();
  const searchable = new Set<string>();

  const claim = (key: string, chipId: string): void => {
    if (key.length < 2) return;
    const holders = claims.get(key) ?? new Set<string>();
    holders.add(chipId);
    claims.set(key, holders);
  };

  const addName = (chipId: string, name: string): void => {
    for (const form of nameForms(name)) {
      claim(normalizePart(form), chipId);
      claim(normalizeWithoutVendor(form, recognition.vendorPrefixes), chipId);
      // A catalogue name is only worth hunting for in prose if it is long enough not to
      // fire on a hex digit run, and if it has a letter in it: `7474` in a ROM comment is
      // an address as often as it is a part, but `Z80` never is.
      if (form.length >= recognition.minCatalogLiteralLength && /[A-Za-z]/.test(form)) {
        searchable.add(form);
      }
    }
  };

  for (const row of chips) {
    const chipId = row['chip_id'];
    const displayName = row['display_name'];
    if (typeof chipId !== 'string') continue;
    addName(chipId, chipId);
    if (typeof displayName === 'string') addName(chipId, displayName);
  }
  for (const row of chipNames) {
    const chipId = row['chip_id'];
    const name = row['name'];
    if (typeof chipId === 'string' && typeof name === 'string') addName(chipId, name);
  }

  const byKey = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const [key, holders] of claims) {
    const only = [...holders][0];
    if (holders.size === 1 && only !== undefined) byKey.set(key, only);
    else ambiguous.add(key);
  }
  for (const [designation, chipId] of recognition.partAliases) {
    const key = normalizeWithoutVendor(designation, recognition.vendorPrefixes);
    byKey.set(key, chipId);
    ambiguous.delete(key);
  }
  for (const ignored of recognition.ignoredParts) {
    searchable.delete(ignored);
  }

  // Longest first so `MC68000` wins over `MC6800` at the same offset, then bytewise so the
  // alternation is a pure function of the catalogue rather than of Set insertion order.
  const ordered = [...searchable].sort((a, b) => b.length - a.length || compareBytes(a, b));
  const literals =
    ordered.length === 0
      ? undefined
      : new RegExp(
          `(?<![A-Za-z0-9])(?:${ordered.map(literalPattern).join('|')})(?![A-Za-z0-9])`,
          'gi',
        );
  return { byKey, ambiguous, literals };
}

/** Resolves one designation. Never throws; an unknown part is a result, not an error. */
export function resolvePart(
  designation: string,
  index: ChipIndex,
  recognition: RecognitionConfig,
): ResolvedPart | undefined {
  const normalized = normalizeWithoutVendor(designation, recognition.vendorPrefixes);
  if (normalized.length < 2) return undefined;
  if (recognition.ignoredParts.has(normalized)) return undefined;
  const chipId = index.byKey.get(normalized) ?? index.byKey.get(normalizePart(designation));
  return {
    designation,
    key: partKey(chipId, normalized),
    normalized,
    ...(chipId !== undefined ? { chipId } : {}),
  };
}

/** One designation found in a body of text, with the line that carried it. */
export interface PartHit {
  readonly designation: string;
  /** 1-based line number within the scanned text. */
  readonly line: number;
  /** The whole line, whitespace-collapsed and clipped: a curator's evidence. */
  readonly evidence: string;
  /** Which rule found it — a `patterns` id, or `catalog` for a known chip name. */
  readonly rule: string;
}

const EVIDENCE_MAX = 160;

function evidenceOf(line: string): string {
  const collapsed = line.replace(/\s+/g, ' ').trim();
  return collapsed.length <= EVIDENCE_MAX ? collapsed : `${collapsed.slice(0, EVIDENCE_MAX - 1)}…`;
}

/**
 * Finds every part designation in `text`, line by line.
 *
 * Two rules run, and the split is what keeps precision high without a hand-maintained list
 * of every part number in the world:
 *
 * - **catalogue literals** match names the dataset already knows, with no context needed.
 *   A comment saying `YM2151` means the YM2151.
 * - **manufacturer grammars** (`recognition.patterns`) match part numbers nobody has
 *   catalogued yet, and each one may demand a context word on the same line. That is what
 *   separates `315-5197 - Custom Sega IC Tilemap Generator (PGA135)` from the same digits
 *   appearing as a ROM label, and it is why the pattern rules are the ones that surface
 *   parts MAME's XML has never heard of.
 *
 * Hits are returned in document order and de-duplicated per line, so one line naming a part
 * twice is one hit. The caller de-duplicates across lines, because it is the caller that
 * decides which of several occurrences is the best citation.
 */
export function scanParts(
  text: string,
  recognition: RecognitionConfig,
  index: ChipIndex,
): PartHit[] {
  const context = new RegExp(recognition.contextPattern, 'i');
  // Every grammar is boundary-anchored here rather than in the config, so no config author
  // can forget to. Without it `GA[0-9]{2}` finds `GA13` inside `(PGA135)` — a package name
  // in a Sega legend line becoming an Irem gate array, which is exactly the kind of
  // plausible-looking wrong fact standing rule 3 refuses.
  const patterns = recognition.patterns.map((rule) => ({
    id: rule.id,
    requiresContext: rule.requiresContext,
    regex: new RegExp(`(?<![A-Za-z0-9])(?:${rule.pattern})(?![A-Za-z0-9])`, 'gi'),
  }));
  const hits: PartHit[] = [];
  const lines = text.split('\n');

  lines.forEach((line, offset) => {
    const seen = new Set<string>();
    const evidence = evidenceOf(line);
    const push = (designation: string, rule: string): void => {
      const key = normalizePart(designation);
      if (key === '' || seen.has(key)) return;
      seen.add(key);
      hits.push({ designation, line: offset + 1, evidence, rule });
    };

    if (index.literals !== undefined) {
      index.literals.lastIndex = 0;
      for (const match of line.matchAll(index.literals)) push(match[0], 'catalog');
    }
    const hasContext = context.test(line);
    for (const rule of patterns) {
      if (rule.requiresContext && !hasContext) continue;
      rule.regex.lastIndex = 0;
      for (const match of line.matchAll(rule.regex)) push(match[0], rule.id);
    }
  });

  return hits;
}
