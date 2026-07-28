/**
 * The Wikidata witness — CC0, so its statements can be reused without condition.
 *
 * One SPARQL query for the whole run, built from the `wikidata` bindings in
 * `config/reconcile-systems.json`. Binding by entity id rather than by label is deliberate:
 * matching "Capcom CPS-1" against a Wikidata label would be a guess, and a wrong guess here
 * attributes another board's CPU to ours. A `Q…` in a reviewed config file is a citation.
 *
 * The query text is derived from the sorted bindings, so it is a pure function of the
 * config — which is what lets the response be cached by request hash and a second run issue
 * no network request at all.
 *
 * **What this witness is worth.** Not much on its own, and that is worth saying plainly:
 * Wikidata models arcade boards thinly, mostly `P880` (CPU) and occasionally `P2560` (GPU),
 * so it confirms the 68000 and the Z80 and stops. Its value is that it is *independent* —
 * neither MAME nor a MAME derivative — so an agreement between it and the driver comments
 * is worth more than either alone, and a disagreement about a main CPU would be a serious
 * finding rather than a curiosity.
 */
import { compareBytes } from '../db/rowfiles.js';
import { resolvePart, type ChipIndex } from './parts.js';
import { collapseParts, type WitnessPart, type WitnessRecord } from './witness.js';
import type { RecognitionConfig, SystemBinding, WikidataConfig } from './config.js';
import type { ReconcileFetcher } from './http.js';

/** One `?item ?prop ?value` row, already reduced to what this module uses. */
export interface WikidataStatement {
  readonly item: string;
  readonly property: string;
  readonly label: string;
}

/**
 * Builds the query. `VALUES` over the bound entities plus a `UNION` per property, because
 * a property path (`?item ?p ?value` with `VALUES ?p`) defeats the label service and
 * returns bare `Q…` ids where labels should be — an answer that looks like data and is not.
 */
export function buildSparql(
  bindings: readonly SystemBinding[],
  config: WikidataConfig,
): string | undefined {
  const items = [...new Set(bindings.flatMap((binding) => binding.wikidata ?? []))].sort(
    compareBytes,
  );
  if (items.length === 0 || config.properties.length === 0) return undefined;
  const values = items.map((id) => `wd:${id}`).join(' ');
  const unions = config.properties
    .map((property) => `{ ?item wdt:${property.id} ?value . BIND("${property.id}" AS ?prop) }`)
    .join('\n  UNION\n  ');
  return [
    'SELECT ?item ?prop ?valueLabel WHERE {',
    `  VALUES ?item { ${values} }`,
    `  ${unions}`,
    '  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,ja,de,fr". }',
    '} ORDER BY ?item ?prop ?valueLabel',
  ].join('\n');
}

/** Parses a SPARQL JSON result set. Anything malformed yields no statements, never a throw. */
export function parseSparqlResults(body: string): WikidataStatement[] {
  let document: unknown;
  try {
    document = JSON.parse(body);
  } catch {
    return [];
  }
  const results = (document as { results?: { bindings?: unknown } } | null)?.results?.bindings;
  if (!Array.isArray(results)) return [];
  const statements: WikidataStatement[] = [];
  for (const row of results as Record<string, { value?: unknown } | undefined>[]) {
    const item = row['item']?.value;
    const property = row['prop']?.value;
    const label = row['valueLabel']?.value;
    if (typeof item !== 'string' || typeof property !== 'string' || typeof label !== 'string') {
      continue;
    }
    // A label the service could not resolve comes back as the entity id itself. That is an
    // absent fact, not a part named `Q667808`, and admitting it would put a Wikidata id in
    // the report as if it were silicon.
    if (/^Q\d+$/.test(label)) continue;
    statements.push({ item: item.replace(/^.*\//, ''), property, label });
  }
  return statements.sort(
    (a, b) =>
      compareBytes(a.item, b.item) ||
      compareBytes(a.property, b.property) ||
      compareBytes(a.label, b.label),
  );
}

export async function wikidataWitness(
  fetcher: ReconcileFetcher,
  config: WikidataConfig,
  bindings: readonly SystemBinding[],
  recognition: RecognitionConfig,
  index: ChipIndex,
  log: (line: string) => void,
): Promise<ReadonlyMap<string, WitnessRecord>> {
  const query = buildSparql(bindings, config);
  if (query === undefined) return new Map();

  const response = await fetcher.fetch(config.endpoint, {
    body: new URLSearchParams({ query, format: 'json' }).toString(),
    accept: 'application/sparql-results+json',
  });
  if (response.status !== 200) {
    log(`reconcile: wikidata: endpoint returned HTTP ${response.status}; witness skipped`);
    return new Map();
  }

  const roles = new Map(config.properties.map((property) => [property.id, property.role]));
  const byItem = new Map<string, WikidataStatement[]>();
  for (const statement of parseSparqlResults(response.body)) {
    byItem.set(statement.item, [...(byItem.get(statement.item) ?? []), statement]);
  }

  const collected = new Map<string, WitnessPart[]>();
  for (const binding of bindings) {
    const statements = binding.wikidata === undefined ? [] : (byItem.get(binding.wikidata) ?? []);
    for (const statement of statements) {
      const resolved = resolvePart(statement.label, index, recognition);
      if (resolved === undefined) continue;
      const part: WitnessPart = {
        key: resolved.key,
        designation: resolved.designation,
        ...(resolved.chipId !== undefined ? { chip_id: resolved.chipId } : {}),
        source_url: `${config.entityBaseUrl}/${binding.wikidata ?? ''}#${statement.property}`,
        evidence: `${binding.wikidata ?? ''} ${statement.property} (${
          roles.get(statement.property) ?? statement.property
        }) = ${statement.label}`,
      };
      collected.set(binding.systemId, [...(collected.get(binding.systemId) ?? []), part]);
    }
  }

  const witnesses = new Map<string, WitnessRecord>();
  for (const [systemId, parts] of collected) {
    const record = collapseParts('wikidata', parts);
    if (record !== undefined) witnesses.set(systemId, record);
  }
  return witnesses;
}
