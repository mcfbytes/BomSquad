/**
 * TASKS T3.8 — the `system16.com` no-fetch guard.
 *
 * ## Why no fixture below writes the domain down
 *
 * The guard scans the whole repository, and this file lives in it. A fixture containing a
 * literal `fetch("https://www.<domain>/…")` would be a violation the guard is *supposed* to
 * catch, so the check would fail on its own test suite — and "add the test file to an
 * allowlist" is exactly the escape hatch that makes such a check worthless.
 *
 * So every fixture is built at run time from `forbiddenHosts[0].domain`, read from the same
 * `config/reconcile.json` the guard and `reconcile/http.ts` read. No address-shaped form of
 * the host exists anywhere in this source — the sentence above it is prose, which is
 * precisely what the guard permits — yet the tests still exercise a real fetch of the real
 * forbidden host, because the string handed to `inspectFile` is character-for-character what
 * a scraper would have written.
 *
 * That also makes these tests self-updating: add a second forbidden host to the config and
 * the last describe block below still proves the tree is clean of it.
 */
import { describe, expect, it } from 'vitest';

import { loadReconcileConfig } from '../src/reconcile/config.js';
import {
  commentSpans,
  formatGuardReport,
  inspectFile,
  isAddressShaped,
  runGuard,
  type GuardOccurrence,
} from '../src/reconcile/guard.js';

const config = loadReconcileConfig();
const guard = config.guard;
const hosts = config.forbiddenHosts;
const domain = hosts[0]?.domain ?? '';
/** The `www.` form, which is what a real scraper would have used. */
const www = `www.${domain}`;

function inspect(path: string, text: string): readonly GuardOccurrence[] {
  return inspectFile(path, text, hosts, guard);
}

function dispositions(path: string, text: string): string[] {
  return inspect(path, text).map((occurrence) => occurrence.disposition);
}

describe('the config declares the host once, for both halves of the rule', () => {
  it('names at least one forbidden domain, with a reason', () => {
    expect(hosts.length).toBeGreaterThan(0);
    expect(hosts[0]?.reason.length ?? 0).toBeGreaterThan(20);
  });
});

describe('a fetch fails, however it is written', () => {
  it('catches a plain fetch of an https URL', () => {
    expect(
      dispositions('pipeline/src/scrape.ts', `await fetch("https://${www}/segabd/");`),
    ).toEqual(['fetch']);
  });

  it('catches a hostname split across concatenated string fragments', () => {
    // The literal domain appears nowhere in this text; only the collapsed view has it.
    const split = `const url = "https://www.${domain.slice(0, 6)}" + "${domain.slice(6)}/x";`;
    expect(split).not.toContain(domain);
    expect(dispositions('pipeline/src/split.ts', split)).toEqual(['fetch']);
  });

  it('catches a bare hostname assigned to a variable', () => {
    expect(dispositions('pipeline/src/host.ts', `const HOST = "${www}";`)).toEqual(['fetch']);
  });

  it('catches a shell client', () => {
    expect(dispositions('scripts/grab.sh', `#!/bin/sh\ncurl -s https://${domain}/x > out`)).toEqual(
      ['fetch'],
    );
  });

  it('catches a bare host on a line with a fetch verb, with no scheme at all', () => {
    expect(dispositions('scripts/grab.sh', `wget ${domain}`)).toEqual(['fetch']);
  });

  it('catches a path-bearing reference even without a scheme', () => {
    expect(dispositions('pipeline/src/x.ts', `const p = ${www}/hardware.php;`)).toEqual(['fetch']);
  });

  it('catches a fetch in a Markdown fenced block, which is not prose', () => {
    const markdown = `# Notes\n\n\`\`\`sh\ncurl https://${www}/x\n\`\`\`\n`;
    expect(dispositions('docs/notes.md', markdown)).toContain('fetch');
  });
});

describe('a citation and a mention are not a fetch', () => {
  it('allows the host as a source_url in a curated row file', () => {
    const row = JSON.stringify(
      {
        system: [{ system_id: 'sega-system16b', source_url: `https://${www}/hardware.php?id=693` }],
      },
      null,
      2,
    );
    expect(dispositions('data/system/sega-system16b.json', row)).toEqual(['citation']);
  });

  it('fails the same host in a row file under a key that is not a citation', () => {
    const row = JSON.stringify({ machine: [{ machine_id: `https://${www}/x` }] }, null, 2);
    expect(dispositions('data/machine/x.json', row)).toEqual(['fetch']);
  });

  it('allows the host as prose in Markdown', () => {
    expect(dispositions('PLAN.md', `${domain} is reference-only, human-directed.`)).toEqual([
      'prose',
    ]);
  });

  it('allows the host named in a doc comment, even next to the word fetch', () => {
    const source = `/**\n * ${domain} may never be fetched; see reconcile/http.ts.\n */\nexport const x = 1;\n`;
    expect(dispositions('pipeline/src/note.ts', source)).toEqual(['prose']);
  });

  it('allows the host inside a sentence in a UI string', () => {
    const source = `const summary = "The ${domain} dimension: platform families.";`;
    expect(dispositions('site/src/app/x.ts', source)).toEqual(['prose']);
  });

  it('allows the denylist itself to name what it denies', () => {
    const declaration = `{\n  "forbidden_hosts": {\n    "${domain}": "reference-only"\n  }\n}\n`;
    expect(dispositions('pipeline/config/reconcile.json', declaration)).toEqual(['prose']);
  });

  it('does not fire on prose that only looks like the domain after collapsing', () => {
    // "System 16. Comparison" collapses to `System16.Comparison`; the boundary rule saves it.
    expect(inspect('docs/x.md', 'Sega System 16. Comparison with System 18 follows.')).toEqual([]);
  });
});

describe('comment lexing, which is what separates documentation from code', () => {
  it('finds line and block comments and ignores comment markers inside strings', () => {
    const text = 'const a = "// not a comment";\n// yes a comment\n/* and this */\n';
    const spans = commentSpans(text, '.ts');
    const commented = spans.map(([start, end]) => text.slice(start, end));
    expect(commented).toEqual(['// yes a comment', '/* and this */']);
  });

  it('treats a file type with no comment syntax as having none', () => {
    expect(commentSpans('{"a": "// b"}', '.json')).toEqual([]);
  });
});

describe('address shape', () => {
  const line = `x "${www}" y`;
  it('calls a whole-string-literal hostname an address in code', () => {
    expect(isAddressShaped(line, line.indexOf(domain), domain.length, true)).toBe(true);
  });
  it('does not, in JSON, where a bare hostname string is data', () => {
    expect(isAddressShaped(line, line.indexOf(domain), domain.length, false)).toBe(false);
  });
  it('calls a hostname inside a sentence prose', () => {
    const sentence = `const s = "the ${domain} dimension";`;
    expect(isAddressShaped(sentence, sentence.indexOf(domain), domain.length, true)).toBe(false);
  });
});

describe('the guard over its own repository', () => {
  const result = runGuard(hosts, guard);

  it('scans a real tree and finds no fetch of a forbidden host', () => {
    expect(result.filesScanned).toBeGreaterThan(100);
    expect(result.violations.map((v) => `${v.path}:${v.line} ${v.detail}`)).toEqual([]);
  });

  it('still sees the host where the project legitimately names it', () => {
    // PLAN §4 and TASKS T3.8 both have to be able to state the rule.
    expect(result.occurrences.some((o) => o.path === 'TASKS.md' && o.disposition === 'prose')).toBe(
      true,
    );
  });

  it('reports a failure with the source owner’s reason attached', () => {
    const seeded = inspect('pipeline/src/scrape.ts', `await fetch("https://${www}/x");`);
    const report = formatGuardReport(
      { filesScanned: 1, occurrences: seeded, violations: [...seeded] },
      hosts,
    );
    expect(report).toContain('FETCH');
    expect(report).toContain(hosts[0]?.reason.slice(0, 30) ?? '');
  });
});
