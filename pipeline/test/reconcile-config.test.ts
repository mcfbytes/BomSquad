/**
 * TASKS T3.8 — the two config files, and the witness parsers that read what they point at.
 *
 * The config assertions are about the *shipped* files, because a load-time check that only
 * ever ran against a synthetic fixture would not stop the real one from shipping broken:
 * an unpinned jtcores branch, an empty denylist or a jt-module mapping with no stated
 * ground are all things that must fail before a run, not during one.
 *
 * The parser assertions use captured response shapes rather than live responses, so the
 * suite stays offline and deterministic.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadReconcileBindings, loadReconcileConfig } from '../src/reconcile/config.js';
import { buildSparql, parseSparqlResults } from '../src/reconcile/wikidata.js';
import {
  infoboxLines,
  parseArticles,
  specificationSection,
  stripWikitext,
} from '../src/reconcile/wikipedia.js';
import { filesForCore, modulesInFile, parseTreePaths } from '../src/reconcile/jtcores.js';

const config = loadReconcileConfig();
const bindings = loadReconcileBindings();

function withConfig(document: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), 'bomsquad-cfg-')), 'reconcile.json');
  writeFileSync(path, JSON.stringify(document));
  return path;
}

describe('the shipped config', () => {
  it('declares at least one forbidden host, each with a reason', () => {
    expect(config.forbiddenHosts.length).toBeGreaterThan(0);
    for (const host of config.forbiddenHosts) expect(host.reason.trim()).not.toBe('');
  });

  it('pins jtcores to a commit, never a branch', () => {
    expect(config.jtcores.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('sorts vendor prefixes longest-first, so stripping is order-independent', () => {
    const lengths = config.recognition.vendorPrefixes.map((prefix) => prefix.length);
    expect(lengths).toEqual([...lengths].sort((a, b) => b - a));
  });

  it('compiles every part grammar at load time', () => {
    for (const pattern of config.recognition.patterns) {
      expect(() => new RegExp(pattern.pattern, 'gi')).not.toThrow();
      expect(pattern.note.trim()).not.toBe('');
    }
  });

  it('refuses an empty denylist, which would silently disable both halves of the rule', () => {
    const document = { ...rawConfigDocument(), forbidden_hosts: {} };
    expect(() => loadReconcileConfig(withConfig(document))).toThrow(/forbidden_hosts.*empty/s);
  });

  it('refuses a reason-free denylist entry', () => {
    const document = {
      ...rawConfigDocument(),
      forbidden_hosts: { 'example.invalid': '' },
    };
    expect(() => loadReconcileConfig(withConfig(document))).toThrow(/non-empty reason/);
  });

  it('refuses a jtcores branch name in place of a pin', () => {
    const raw = rawConfigDocument();
    const witnesses = raw['witnesses'] as Record<string, Record<string, unknown>>;
    const document = {
      ...raw,
      witnesses: { ...witnesses, jtcores: { ...witnesses['jtcores'], commit: 'master' } },
    };
    expect(() => loadReconcileConfig(withConfig(document))).toThrow(/40-character SHA-1/);
  });
});

/** The shipped file re-read as plain JSON, so a negative test can mutate one field of it. */
function rawConfigDocument(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(import.meta.dirname, '..', 'config', 'reconcile.json'), 'utf8'),
  ) as Record<string, unknown>;
}

describe('the shipped bindings', () => {
  it('binds at least 20 systems to an independent witness', () => {
    // TASKS T3.8's acceptance gate. The MAME driver-source witness needs no binding at all
    // — it follows system_driver — so this is a floor on the *other* three.
    const bound = bindings.systems.filter(
      (binding) =>
        binding.wikidata !== undefined ||
        binding.wikipedia !== undefined ||
        binding.jtcores.length > 0,
    );
    expect(bound.length).toBeGreaterThanOrEqual(20);
  });

  it('states the ground for every jt-module mapping', () => {
    expect(bindings.jtModules.length).toBeGreaterThan(0);
    for (const module of bindings.jtModules) {
      expect(module.part.trim()).not.toBe('');
      expect(module.note.trim()).not.toBe('');
    }
  });

  it('is sorted, so no consumer can leak the file order into an output', () => {
    const ids = bindings.systems.map((binding) => binding.systemId);
    expect(ids).toEqual([...ids].sort());
  });
});

describe('wikidata', () => {
  it('builds one query from the sorted bindings, with a UNION per property', () => {
    const query = buildSparql(
      [
        { systemId: 'b', wikidata: 'Q2', jtcores: [] },
        { systemId: 'a', wikidata: 'Q1', jtcores: [] },
      ],
      config.wikidata,
    );
    expect(query).toContain('VALUES ?item { wd:Q1 wd:Q2 }');
    expect(query).toContain('BIND("P880" AS ?prop)');
  });

  it('has no query at all when nothing is bound', () => {
    expect(buildSparql([{ systemId: 'a', jtcores: [] }], config.wikidata)).toBeUndefined();
  });

  it('parses a result set and drops labels the service could not resolve', () => {
    const body = JSON.stringify({
      results: {
        bindings: [
          {
            item: { value: 'http://www.wikidata.org/entity/Q1034233' },
            prop: { value: 'P880' },
            valueLabel: { value: 'MC68000' },
          },
          {
            item: { value: 'http://www.wikidata.org/entity/Q1' },
            prop: { value: 'P880' },
            // An unlabelled value comes back as its own id; that is an absent fact, and
            // admitting it would put a Wikidata id in the report as if it were silicon.
            valueLabel: { value: 'Q667808' },
          },
        ],
      },
    });
    expect(parseSparqlResults(body)).toEqual([
      { item: 'Q1034233', property: 'P880', label: 'MC68000' },
    ]);
  });

  it('treats a malformed response as no statements rather than throwing', () => {
    expect(parseSparqlResults('<html>502</html>')).toEqual([]);
  });
});

describe('wikipedia', () => {
  it('strips references, templates and link syntax, keeping the link target', () => {
    const text = stripWikitext(
      '[[Motorola 68000|68000]] @ 10&nbsp;[[MHz]]<ref name=x>{{cite web|url=y}}</ref>',
    );
    expect(text).toContain('Motorola 68000');
    expect(text).not.toContain('cite web');
    expect(text).not.toContain('&nbsp;');
  });

  it('reads only the infobox parameters it was asked for', () => {
    const wikitext = '| cpu = [[Zilog Z80]]\n| release_date = 1988\n| sound = [[YM2151]]\n';
    expect(infoboxLines(wikitext, ['cpu', 'sound'])).toEqual(['cpu = Zilog Z80', 'sound = YM2151']);
  });

  it('reads the specification list, and only the list', () => {
    const wikitext = [
      '==Technical specifications==',
      'The SM83 is a hybrid of the [[Intel 8080]] and the [[Zilog Z80]].',
      '*[[CPU]]: [[Sharp SM83]]',
      '==Reception==',
      '*Not a specification at all',
    ].join('\n');
    // The prose sentence names two processors the console does not contain; a bullet is a
    // BOM entry and a paragraph is an essay.
    expect(specificationSection(wikitext, ['technical specifications'])).toEqual([
      '*CPU: Sharp SM83',
    ]);
  });

  it('parses a revisions response, keeping the revid a citation needs', () => {
    const body = JSON.stringify({
      query: {
        pages: [
          {
            title: 'CP System',
            revisions: [{ revid: 42, slots: { main: { content: '| cpu = x' } } }],
          },
          { title: 'Missing', missing: true },
        ],
      },
    });
    expect(parseArticles(body)).toEqual([
      { title: 'CP System', revisionId: 42, wikitext: '| cpu = x' },
    ]);
  });
});

describe('jtcores', () => {
  it('reads instantiations out of Verilog and dependencies out of YAML', () => {
    expect(modulesInFile('jt51 u_jt51(\n    .rst(rst),\n);\n', 'verilog')).toEqual([
      { module: 'jt51', line: 1, evidence: 'jt51 u_jt51(' },
    ]);
    expect(modulesInFile('jt6295 #(.INTERPOL(0)) u_adpcm(\n', 'verilog')[0]?.module).toBe('jt6295');
    expect(modulesInFile('cps1:\n  - get:\njt51:\njt6295:\n', 'yaml').map((m) => m.module)).toEqual(
      ['cps1', 'jt51', 'jt6295'],
    );
  });

  it('selects only the core files the config names', () => {
    const paths = parseTreePaths(
      JSON.stringify({
        tree: [
          { path: 'cores/cps1/hdl/jtcps1_game.v' },
          { path: 'cores/cps1/hdl/jtcps1_obj.v' },
          { path: 'cores/cps1/cfg/files.yaml' },
          { path: 'cores/s16b/hdl/jts16b_snd.v' },
        ],
      }),
    );
    expect(filesForCore(paths, 'cps1', config.jtcores)).toEqual([
      'cores/cps1/cfg/files.yaml',
      'cores/cps1/hdl/jtcps1_game.v',
    ]);
  });
});
