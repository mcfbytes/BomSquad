/**
 * `pipeline reconcile:guard` — the review-time half of the system16.com rule.
 *
 * TASKS T3.8: *"a CI check greps the repo for `system16.com` and fails on any fetch call,
 * allowing it only as a `source_url` string in curated row files and as prose in
 * Markdown."* The host is a legitimate human-directed reference — a curator may read a page
 * and cite it — and an illegitimate fetch target, and the whole job of this file is to tell
 * those two apart mechanically.
 *
 * ## The three dispositions
 *
 * Every occurrence of a forbidden domain gets exactly one:
 *
 * 1. **Curated row file** (`data/**\/*.json`). Allowed only as the *value* of a key in
 *    `guard.allowed_row_keys` — `source_url`, `notes`, `reason`. Decided by parsing the
 *    JSON and walking it, not by looking at the surrounding text, so a host smuggled into a
 *    key name or a `machine_id` is a failure however it is quoted.
 * 2. **Markdown** (`*.md`). Allowed: PLAN §4 and TASKS T3.8 both have to be able to *say*
 *    the name to state the rule. A fenced code block is not prose, so a fence that also
 *    contains a fetch verb fails — a copy-pasteable `curl` is a fetch whichever file it
 *    lives in.
 * 3. **Everything else.** Allowed as prose, and *only* as prose. A doc comment or a UI
 *    string may name the site — `site/src/app/systems/system-browser.ts` calls platform
 *    families "the ⟨host⟩ dimension" — because naming a reference is the whole point of it
 *    being a reference. It fails when the occurrence is **address-shaped** or sits in
 *    **executable proximity to a fetch**, defined below.
 *
 * ## Address-shaped
 *
 * The occurrence is an address rather than a word when any of these hold, and each is a
 * different way of writing the same fetch:
 *
 * - a scheme or protocol-relative prefix runs into it (`https:` + `//`, or a bare `//`);
 * - a path follows it (`/segabd/…`);
 * - it is the *entire* contents of a `'`- or `"`-delimited literal, which is what
 *   `const host = "…"` looks like after someone moves the scheme elsewhere.
 *
 * The last rule is skipped for `.json`, where a bare hostname string is data — it is how
 * `config/reconcile.json` declares the denylist in the first place, and a check that
 * forbade the denylist from naming what it denies would be self-defeating. Backtick
 * literals are exempt from it too, because in a doc comment a backtick means code font, not
 * a template literal, and every JSDoc in this repository writes hostnames that way.
 *
 * ## Executable proximity
 *
 * A fetch verb from `guard.fetch_verbs` within `guard.fetch_context_lines` lines fails the
 * occurrence — but only when the occurrence is **outside a comment**. That exemption is not
 * a loophole: this very file has to be able to describe the rule it enforces, and a
 * paragraph explaining what happens near a `fetch(` is not a fetch. Comment ranges are
 * lexed per language ({@link COMMENT_STYLES}), not guessed from indentation, and the
 * address-shaped rules above still apply *inside* comments — a real URL in a comment is a
 * fetch waiting for someone to uncomment it.
 *
 * ## Why a plain grep is not enough
 *
 * A hostname split across two string fragments and joined with `+` contains no substring
 * matching the domain at all, so every file is scanned twice: once as written, and once
 * through a **concatenation-collapsed** view with quotes, backticks, `+`, backslashes and
 * whitespace removed. In that view the two fragments abut and the domain reappears, taking
 * its scheme with it. A per-line offset table maps the collapsed match back to a real line,
 * and a collapsed hit on a line that *already* matched as written is discarded — the second
 * pass exists to find splits, not to re-judge prose.
 *
 * The collapse removes exactly the characters that appear *between* fragments of one
 * concatenated literal, and no others. In particular `.` is kept, so `System 16.
 * Comparison` in prose cannot collapse into a hostname; and both passes require a boundary
 * on each side of the match, so `system16.compare` is not `system16.com`. That is what lets
 * this run over PLAN.md, TASKS.md and the site's own copy without a false positive.
 *
 * ## What it cannot catch, said plainly
 *
 * A hostname assembled from data this scan never sees — read out of a file at run time,
 * built from character codes, base64-decoded — is not statically detectable, and no
 * grep-shaped check can claim otherwise. That case is covered by the *other* half of the
 * rule: `reconcile/http.ts` refuses the host at run time, from the same
 * `config/reconcile.json` list this file reads. The two are independent, and this check has
 * no path allowlist at all, so there is no file anyone can add themselves to.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';

import { compareBytes } from '../db/rowfiles.js';
import { REPO_ROOT } from '../mame/config.js';
import type { ForbiddenHost, GuardConfig } from './config.js';

export const GUARD_DISPOSITIONS = ['fetch', 'citation', 'prose'] as const;
export type GuardDisposition = (typeof GUARD_DISPOSITIONS)[number];

/** One occurrence of a forbidden domain, and what this file made of it. */
export interface GuardOccurrence {
  /** Repository-relative, `/`-separated. */
  readonly path: string;
  readonly line: number;
  readonly domain: string;
  readonly disposition: GuardDisposition;
  /** Why: the rule that fired, in a sentence a reviewer can act on. */
  readonly detail: string;
  /** The line, whitespace-collapsed and clipped. */
  readonly evidence: string;
}

export interface GuardResult {
  readonly filesScanned: number;
  /** Bytewise sorted by path, then line. */
  readonly occurrences: readonly GuardOccurrence[];
  /** The subset with disposition `fetch`. Non-empty means the check fails. */
  readonly violations: readonly GuardOccurrence[];
}

/** Characters that can sit between two fragments of one concatenated string literal. */
const JOINERS = /['"`+\\\s]/g;

const EVIDENCE_MAX = 160;

function evidenceOf(line: string): string {
  const collapsed = line.replace(/\s+/g, ' ').trim();
  return collapsed.length <= EVIDENCE_MAX ? collapsed : `${collapsed.slice(0, EVIDENCE_MAX - 1)}…`;
}

/**
 * The concatenation-collapsed view of a file, plus the line each collapsed character came
 * from. Built per line so a match offset maps back to a real line number, and so a
 * concatenation split across lines still joins.
 */
export function collapseJoiners(lines: readonly string[]): {
  readonly text: string;
  readonly lineAt: (offset: number) => number;
} {
  let text = '';
  /** Collapsed offset at which each source line begins. */
  const starts: number[] = [];
  for (const line of lines) {
    starts.push(text.length);
    text += line.replace(JOINERS, '');
  }
  const lineAt = (offset: number): number => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if ((starts[middle] ?? 0) <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
  return { text, lineAt };
}

/** A domain with a boundary each side, so `system16.compare` is not a match. */
function domainPattern(domain: string): RegExp {
  const escaped = domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9-])${escaped}(?![A-Za-z0-9-])`, 'gi');
}

/**
 * Comment syntax per file extension. A language fact, not a project judgement, so it lives
 * here rather than in `config/reconcile.json`. An extension with no entry has no comments
 * as far as this check is concerned, which is the right answer for `.json`.
 */
const COMMENT_STYLES: ReadonlyMap<
  string,
  { readonly line?: string; readonly block?: readonly [string, string] }
> = new Map([
  ['.ts', { line: '//', block: ['/*', '*/'] as const }],
  ['.tsx', { line: '//', block: ['/*', '*/'] as const }],
  ['.js', { line: '//', block: ['/*', '*/'] as const }],
  ['.mjs', { line: '//', block: ['/*', '*/'] as const }],
  ['.cjs', { line: '//', block: ['/*', '*/'] as const }],
  ['.cpp', { line: '//', block: ['/*', '*/'] as const }],
  ['.c', { line: '//', block: ['/*', '*/'] as const }],
  ['.h', { line: '//', block: ['/*', '*/'] as const }],
  ['.scss', { line: '//', block: ['/*', '*/'] as const }],
  ['.css', { block: ['/*', '*/'] as const }],
  ['.sql', { line: '--', block: ['/*', '*/'] as const }],
  ['.sh', { line: '#' }],
  ['.bash', { line: '#' }],
  ['.yml', { line: '#' }],
  ['.yaml', { line: '#' }],
  ['.py', { line: '#' }],
  ['.toml', { line: '#' }],
  ['.html', { block: ['<!--', '-->'] as const }],
  ['.xml', { block: ['<!--', '-->'] as const }],
  ['.svg', { block: ['<!--', '-->'] as const }],
]);

/** Character offsets `[start, end)` of every comment in `text`, for that extension. */
export function commentSpans(
  text: string,
  extension: string,
): readonly (readonly [number, number])[] {
  const style = COMMENT_STYLES.get(extension.toLowerCase());
  if (style === undefined) return [];
  const spans: (readonly [number, number])[] = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === '"' || character === "'" || character === '`') {
      index += 1;
      while (index < text.length && text[index] !== character) {
        index += text[index] === '\\' ? 2 : 1;
      }
      index += 1;
      continue;
    }
    if (style.line !== undefined && text.startsWith(style.line, index)) {
      const end = text.indexOf('\n', index);
      const stop = end < 0 ? text.length : end;
      spans.push([index, stop]);
      index = stop;
      continue;
    }
    if (style.block !== undefined && text.startsWith(style.block[0], index)) {
      const end = text.indexOf(style.block[1], index + style.block[0].length);
      const stop = end < 0 ? text.length : end + style.block[1].length;
      spans.push([index, stop]);
      index = stop;
      continue;
    }
    index += 1;
  }
  return spans;
}

/**
 * Whether an occurrence is an address rather than a word. See the module comment; `allowBare`
 * is false for `.json`, where a hostname string is data rather than a variable assignment.
 */
export function isAddressShaped(
  line: string,
  offset: number,
  length: number,
  allowBare: boolean,
): boolean {
  const before = line.slice(Math.max(0, offset - 24), offset);
  if (/(?:https?:)?\/\/[A-Za-z0-9.-]*$/.test(before)) return true;
  if (/^\/[^\s"'`]/.test(line.slice(offset + length))) return true;
  if (!allowBare) return false;
  // The maximal address run around the occurrence, then the literal that encloses it.
  const runStart = offset - (/[A-Za-z0-9.:/?#=&%~_+-]*$/.exec(before)?.[0].length ?? 0);
  const runEnd =
    offset +
    length +
    (/^[A-Za-z0-9.:/?#=&%~_+-]*/.exec(line.slice(offset + length))?.[0].length ?? 0);
  const opener = line.lastIndexOf('"', runStart) >= 0 ? '"' : "'";
  const open = line.lastIndexOf(opener, runStart - 1);
  if (open < 0) return false;
  const close = line.indexOf(opener, runEnd);
  return close === runEnd && open === runStart - 1;
}

/** Every value in a parsed JSON document, with the key path that reached it. */
function walkJsonStrings(
  value: unknown,
  key: string,
  visit: (key: string, text: string) => void,
): void {
  if (typeof value === 'string') {
    visit(key, value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkJsonStrings(item, key, visit);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [name, child] of Object.entries(value)) {
      visit(`${key}#name`, name);
      walkJsonStrings(child, name, visit);
    }
  }
}

/** Offsets at which fenced code blocks open and close, for the Markdown rule. */
function fencedRanges(lines: readonly string[]): readonly { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  let open: number | undefined;
  lines.forEach((line, index) => {
    if (!/^\s*(?:```|~~~)/.test(line)) return;
    if (open === undefined) open = index + 1;
    else {
      ranges.push({ start: open, end: index + 1 });
      open = undefined;
    }
  });
  if (open !== undefined) ranges.push({ start: open, end: lines.length });
  return ranges;
}

/**
 * Applies the three dispositions to one file's text. Pure — no I/O — so the tests can
 * present a seeded fetch without one ever existing on disk.
 *
 * `path` is repository-relative and `/`-separated; it is what decides which rule applies.
 */
export function inspectFile(
  path: string,
  text: string,
  forbiddenHosts: readonly ForbiddenHost[],
  config: GuardConfig,
): readonly GuardOccurrence[] {
  const lines = text.split('\n');
  const collapsed = collapseJoiners(lines);
  const extension = extname(path).toLowerCase();
  const isProse = config.proseExtensions.includes(extension);
  const isJson = extension === '.json';
  const isRowFile =
    isJson && config.rowFileRoots.some((root) => path === root || path.startsWith(`${root}/`));
  const fences = isProse ? fencedRanges(lines) : [];

  /** Absolute offset of the start of each line, for the comment-span lookup. */
  const lineOffsets: number[] = [];
  let running = 0;
  for (const line of lines) {
    lineOffsets.push(running);
    running += line.length + 1;
  }
  const spans = isProse ? [] : commentSpans(text, extension);
  const inComment = (line: number, column: number): boolean => {
    const offset = (lineOffsets[line - 1] ?? 0) + column;
    return spans.some(([start, end]) => offset >= start && offset < end);
  };

  /** Row-file lines whose value sits under an allowed key. Empty for every other file. */
  const citationLines = new Set<number>();
  if (isRowFile) {
    const allowed = new Set(config.allowedRowKeys);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const cited = new Set<string>();
    walkJsonStrings(parsed, '', (key, value) => {
      if (allowed.has(key)) cited.add(value);
    });
    lines.forEach((line, index) => {
      for (const value of cited) {
        // The emitted form of a JSON string value; a value spanning lines cannot occur,
        // because `canonicalRowFileJson` writes one row key per line.
        if (line.includes(JSON.stringify(value))) citationLines.add(index + 1);
      }
    });
  }

  const found = new Map<string, GuardOccurrence>();
  const consider = (
    domain: string,
    line: number,
    addressShaped: boolean,
    commented: boolean,
    split: boolean,
  ): void => {
    const evidence = evidenceOf(lines[line - 1] ?? '');
    const window = lines
      .slice(Math.max(0, line - 1 - config.fetchContextLines), line + config.fetchContextLines)
      .join('\n')
      .toLowerCase();
    // Only code is judged by what is near it; see "Executable proximity" above.
    const verb = commented
      ? undefined
      : config.fetchVerbs.find((candidate) => window.includes(candidate));
    const how = split ? ' (assembled from string fragments)' : '';

    let disposition: GuardDisposition;
    let detail: string;
    if (isRowFile) {
      if (citationLines.has(line) && !split) {
        disposition = 'citation';
        detail = `cited under one of ${config.allowedRowKeys.join('/')} in a curated row file`;
      } else {
        disposition = 'fetch';
        detail =
          `'${domain}' appears in a curated row file outside a ` +
          `${config.allowedRowKeys.join('/')} value${how}`;
      }
    } else if (isProse) {
      const fenced = fences.some((range) => line > range.start && line < range.end);
      if (fenced && verb !== undefined) {
        disposition = 'fetch';
        detail = `'${domain}' inside a fenced code block that also contains '${verb}'`;
      } else {
        disposition = 'prose';
        detail = `'${domain}' as prose in Markdown`;
      }
    } else if (addressShaped) {
      disposition = 'fetch';
      detail = `'${domain}' written as an address, not a word${how}`;
    } else if (verb !== undefined) {
      disposition = 'fetch';
      detail = `'${domain}' in code within ${config.fetchContextLines} lines of '${verb}'${how}`;
    } else {
      disposition = 'prose';
      detail = `'${domain}' named in prose: no scheme, no path, not a bare string literal`;
    }

    const id = `${line}:${domain}`;
    const existing = found.get(id);
    // A domain seen by both passes is one occurrence; the harsher verdict wins.
    if (existing === undefined || (existing.disposition !== 'fetch' && disposition === 'fetch')) {
      found.set(id, { path, line, domain, disposition, detail, evidence });
    }
  };

  for (const host of forbiddenHosts) {
    const pattern = domainPattern(host.domain);
    /** Lines the as-written pass already judged, so the collapsed pass skips them. */
    const literal = new Set<number>();
    lines.forEach((line, index) => {
      pattern.lastIndex = 0;
      for (const match of line.matchAll(pattern)) {
        literal.add(index + 1);
        consider(
          host.domain,
          index + 1,
          isAddressShaped(line, match.index, match[0].length, !isJson),
          inComment(index + 1, match.index),
          false,
        );
      }
    });
    pattern.lastIndex = 0;
    for (const match of collapsed.text.matchAll(pattern)) {
      const line = collapsed.lineAt(match.index);
      // Prose survives the collapse unchanged, so a collapsed hit on a line that already
      // matched as written is the same occurrence, not a concatenation. Re-judging it here
      // — with no comment context and no quotes — would fail every doc comment in the tree.
      if (literal.has(line)) continue;
      consider(
        host.domain,
        line,
        isAddressShaped(collapsed.text, match.index, match[0].length, !isJson),
        false,
        true,
      );
    }
  }

  return [...found.values()].sort((a, b) => a.line - b.line || compareBytes(a.domain, b.domain));
}

/** Every file the guard reads, repository-relative and `/`-separated, bytewise sorted. */
export function guardFiles(root: string, config: GuardConfig): string[] {
  const skipDirectories = new Set(config.skipDirectories);
  const skipFiles = new Set(config.skipFiles);
  const found: string[] = [];
  const walk = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirectories.has(entry.name)) walk(path);
        continue;
      }
      if (!entry.isFile() || skipFiles.has(entry.name)) continue;
      let size: number;
      try {
        size = statSync(path).size;
      } catch {
        continue;
      }
      if (size > config.maxFileBytes) continue;
      found.push(relative(root, path).split(sep).join('/'));
    }
  };
  walk(root);
  return found.sort(compareBytes);
}

/** A file with a NUL byte in its head is binary; scanning it would find nothing but noise. */
function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8192).includes(0);
}

/** Runs the guard over a tree. `root` defaults to the repository. */
export function runGuard(
  forbiddenHosts: readonly ForbiddenHost[],
  config: GuardConfig,
  root: string = REPO_ROOT,
): GuardResult {
  const occurrences: GuardOccurrence[] = [];
  const paths = guardFiles(root, config);
  let scanned = 0;
  for (const path of paths) {
    let buffer: Buffer;
    try {
      buffer = readFileSync(join(root, path));
    } catch {
      continue;
    }
    if (isBinary(buffer)) continue;
    scanned += 1;
    occurrences.push(...inspectFile(path, buffer.toString('utf8'), forbiddenHosts, config));
  }
  const sorted = occurrences.sort(
    (a, b) => compareBytes(a.path, b.path) || a.line - b.line || compareBytes(a.domain, b.domain),
  );
  return {
    filesScanned: scanned,
    occurrences: sorted,
    violations: sorted.filter((occurrence) => occurrence.disposition === 'fetch'),
  };
}

/** The report `pipeline reconcile:guard` prints. Failures first, then what was allowed. */
export function formatGuardReport(
  result: GuardResult,
  forbidden: readonly ForbiddenHost[],
): string {
  const lines: string[] = [];
  const domains = forbidden.map((host) => host.domain).join(', ');
  lines.push(`reconcile:guard: ${result.filesScanned} files scanned for ${domains}`);
  for (const violation of result.violations) {
    lines.push(`  FETCH   ${violation.path}:${violation.line} — ${violation.detail}`);
    lines.push(`          ${violation.evidence}`);
  }
  for (const allowed of result.occurrences) {
    if (allowed.disposition === 'fetch') continue;
    lines.push(
      `  ${allowed.disposition === 'citation' ? 'CITE ' : 'PROSE'}   ` +
        `${allowed.path}:${allowed.line} — ${allowed.detail}`,
    );
  }
  if (result.violations.length === 0) {
    lines.push('reconcile:guard: no fetch of a forbidden host. OK');
  } else {
    lines.push(
      `reconcile:guard: ${result.violations.length} violation(s). ` + (forbidden[0]?.reason ?? ''),
    );
  }
  return `${lines.join('\n')}\n`;
}
