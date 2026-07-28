/**
 * The English Wikipedia witness — CC-BY-SA-4.0, the same licence as `LICENSE-DATA`, so a
 * curated row derived from it can be redistributed under the terms this project already
 * publishes under.
 *
 * ## What is read, and what is not
 *
 * Two regions of an article, and nothing else:
 *
 * - the **infobox** parameters named in `witnesses.wikipedia.infobox_fields`
 *   (`| cpu = [[Motorola 68000]] (@ 10 [[MHz]])`);
 * - the body of a **specifications section** named in `section_headings`, which is where
 *   the bullet list of sound chips and co-processors lives.
 *
 * The rest of an article is history, reception and a games table, and scanning it would
 * produce a part list contaminated by every chip mentioned in passing. Restricting to two
 * regions is what makes this witness usable without a per-article allowlist of parts.
 *
 * ## Citations point at a revision, not a page
 *
 * The API is asked for `rvprop=ids|content`, and every finding cites
 * `…/index.php?oldid=<revid>`. A curator opening that link sees the sentence this run read,
 * not whatever the article says today — which is the difference between a citation and a
 * pointer. It is also what makes a cached run reproducible in a way a reader can verify.
 *
 * ## Fidelity, honestly stated
 *
 * Wikitext is not a data format. `2x CPS Super Chip` is what the CP System article calls the
 * CPS-A/CPS-B pair, and no amount of parsing turns that into two part numbers. This witness
 * therefore finds fewer parts than the driver comments do and phrases some of them
 * differently; it is here because it is genuinely independent of MAME, not because it is
 * precise.
 */
import { compareBytes } from '../db/rowfiles.js';
import { resolvePart, scanParts, type ChipIndex } from './parts.js';
import { collapseParts, type WitnessPart, type WitnessRecord } from './witness.js';
import type { RecognitionConfig, SystemBinding, WikipediaConfig } from './config.js';
import type { ReconcileFetcher } from './http.js';

/** One article as this module needs it. */
export interface Article {
  readonly title: string;
  readonly revisionId: number;
  readonly wikitext: string;
}

/**
 * Strips the wiki markup that would otherwise hide a part number: references, templates,
 * HTML, link syntax and non-breaking spaces. Link *targets* are kept in preference to
 * display text (`[[Motorola 68000|68000]]` -> `Motorola 68000`), because the target is the
 * article's own canonical name for the thing and the display text is prose.
 */
export function stripWikitext(text: string): string {
  let out = text
    .replace(/<ref[^>]*\/>/gi, ' ')
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
  // Templates can nest; peel one layer at a time until none is left or nothing changes.
  for (let pass = 0; pass < 8; pass += 1) {
    const next = out.replace(/\{\{[^{}]*\}\}/g, ' ');
    if (next === out) break;
    out = next;
  }
  return out
    .replace(/\[\[([^[\]|]+)\|[^[\]]*\]\]/g, '$1')
    .replace(/\[\[([^[\]]+)\]\]/g, '$1')
    .replace(/'{2,}/g, '');
}

/** The infobox parameter lines whose names are in `fields`, one per output line. */
export function infoboxLines(wikitext: string, fields: readonly string[]): string[] {
  const wanted = new Set(fields.map((field) => field.toLowerCase().replace(/[^a-z0-9]/g, '')));
  const lines: string[] = [];
  for (const raw of wikitext.split('\n')) {
    const parameter = /^\s*\|\s*([A-Za-z0-9_ -]+?)\s*=\s*(.*)$/.exec(raw);
    const name = parameter?.[1];
    const value = parameter?.[2];
    if (name === undefined || value === undefined) continue;
    if (!wanted.has(name.toLowerCase().replace(/[^a-z0-9]/g, ''))) continue;
    lines.push(`${name} = ${stripWikitext(value)}`);
  }
  return lines;
}

/**
 * The **list items** of the first section whose heading matches one of `headings`.
 *
 * List items only, not the whole section, and that restriction is doing real work. A
 * specifications *list* is a BOM in prose form (`**[[Yamaha]] [[YM2151]] @ 3.579 MHz`); a
 * *paragraph* in the same section is an essay about it. The Game Boy article's
 * specifications section explains that the Sharp SM83 is "a hybrid of the Intel 8080 and
 * Zilog Z80" — scanning that sentence yields an 8080 and a Z80 the Game Boy does not
 * contain, presented with a citation, which is worse than no finding at all.
 */
export function specificationSection(
  wikitext: string,
  headings: readonly string[],
): readonly string[] {
  const wanted = new Set(headings.map((heading) => heading.toLowerCase()));
  const lines = wikitext.split('\n');
  const body: string[] = [];
  let inside = false;
  for (const line of lines) {
    const heading = /^\s*(={2,6})\s*(.+?)\s*\1\s*$/.exec(line);
    if (heading !== null) {
      const title = (heading[2] ?? '')
        .replace(/\[\[|\]\]/g, '')
        .toLowerCase()
        .trim();
      if (inside) break; // one section only; the next heading ends it
      inside = wanted.has(title);
      continue;
    }
    if (inside && /^\s*[*#;|]/.test(line)) body.push(stripWikitext(line));
  }
  return body;
}

/** Parses the `action=query&prop=revisions` response, tolerating missing pages. */
export function parseArticles(body: string): Article[] {
  let document: unknown;
  try {
    document = JSON.parse(body);
  } catch {
    return [];
  }
  const pages = (document as { query?: { pages?: unknown } } | null)?.query?.pages;
  if (!Array.isArray(pages)) return [];
  const articles: Article[] = [];
  for (const page of pages as Record<string, unknown>[]) {
    const title = page['title'];
    const revisions = page['revisions'];
    if (typeof title !== 'string' || !Array.isArray(revisions)) continue;
    const revision = revisions[0] as Record<string, unknown> | undefined;
    const revisionId = revision?.['revid'];
    const slots = revision?.['slots'] as Record<string, unknown> | undefined;
    const main = slots?.['main'] as Record<string, unknown> | undefined;
    const content = main?.['content'];
    if (typeof revisionId !== 'number' || typeof content !== 'string') continue;
    articles.push({ title, revisionId, wikitext: content });
  }
  return articles.sort((a, b) => compareBytes(a.title, b.title));
}

/** Titles the API normalised or redirected, so a binding still finds its article. */
function aliasMap(body: string): ReadonlyMap<string, string> {
  const aliases = new Map<string, string>();
  let document: unknown;
  try {
    document = JSON.parse(body);
  } catch {
    return aliases;
  }
  const query = (document as { query?: Record<string, unknown> } | null)?.query;
  for (const key of ['normalized', 'redirects']) {
    const entries = query?.[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries as Record<string, unknown>[]) {
      const from = entry['from'];
      const to = entry['to'];
      if (typeof from === 'string' && typeof to === 'string') aliases.set(from, to);
    }
  }
  return aliases;
}

/** Resolves a bound title through however many normalisation/redirect hops it takes. */
function resolveTitle(title: string, aliases: ReadonlyMap<string, string>): string {
  let current = title;
  for (let hop = 0; hop < 4; hop += 1) {
    const next = aliases.get(current);
    if (next === undefined) return current;
    current = next;
  }
  return current;
}

export async function wikipediaWitness(
  fetcher: ReconcileFetcher,
  config: WikipediaConfig,
  bindings: readonly SystemBinding[],
  recognition: RecognitionConfig,
  index: ChipIndex,
  log: (line: string) => void,
): Promise<ReadonlyMap<string, WitnessRecord>> {
  const titles = [...new Set(bindings.flatMap((binding) => binding.wikipedia ?? []))].sort(
    compareBytes,
  );
  if (titles.length === 0) return new Map();

  const articles = new Map<string, Article>();
  const aliases = new Map<string, string>();
  for (let start = 0; start < titles.length; start += config.titlesPerRequest) {
    const batch = titles.slice(start, start + config.titlesPerRequest);
    const url = `${config.apiUrl}?${new URLSearchParams({
      action: 'query',
      prop: 'revisions',
      rvprop: 'ids|content',
      rvslots: 'main',
      redirects: '1',
      titles: batch.join('|'),
      format: 'json',
      formatversion: '2',
    }).toString()}`;
    const response = await fetcher.fetch(url, { accept: 'application/json' });
    if (response.status !== 200) {
      log(`reconcile: wikipedia: batch returned HTTP ${response.status}; skipped`);
      continue;
    }
    for (const [from, to] of aliasMap(response.body)) aliases.set(from, to);
    for (const article of parseArticles(response.body)) articles.set(article.title, article);
  }

  const collected = new Map<string, WitnessPart[]>();
  for (const binding of bindings) {
    if (binding.wikipedia === undefined) continue;
    const article = articles.get(resolveTitle(binding.wikipedia, aliases));
    if (article === undefined) {
      log(`reconcile: wikipedia: no article for '${binding.wikipedia}' (${binding.systemId})`);
      continue;
    }
    const url = `${config.permalinkBaseUrl}${article.revisionId}`;
    const regions = [
      ...infoboxLines(article.wikitext, config.infoboxFields).map(
        (line) => ['infobox', line] as const,
      ),
      ...specificationSection(article.wikitext, config.sectionHeadings).map(
        (line) => ['specs', line] as const,
      ),
    ];
    for (const [region, line] of regions) {
      for (const hit of scanParts(line, recognition, index)) {
        const resolved = resolvePart(hit.designation, index, recognition);
        if (resolved === undefined) continue;
        collected.set(binding.systemId, [
          ...(collected.get(binding.systemId) ?? []),
          {
            key: resolved.key,
            designation: resolved.designation,
            ...(resolved.chipId !== undefined ? { chip_id: resolved.chipId } : {}),
            source_url: url,
            evidence: `${article.title} (${region}): ${hit.evidence}`,
          },
        ]);
      }
    }
  }

  const witnesses = new Map<string, WitnessRecord>();
  for (const [systemId, parts] of collected) {
    const record = collapseParts('wikipedia', parts);
    if (record !== undefined) witnesses.set(systemId, record);
  }
  return witnesses;
}
