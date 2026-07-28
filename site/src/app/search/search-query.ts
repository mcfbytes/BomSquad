import { type QuerySpec, escapeLikePattern } from '../data/sql';

/**
 * Global search (T7.3) — one SQL statement against the database T7.2 already
 * opened.
 *
 * There is no search index, no second artifact and no second network request: the
 * whole point of shipping a relational engine to the browser is that "find me
 * everything called ym2151" is a `SELECT`. `global-search.spec.ts` asserts that
 * property directly — it counts every `fetch` during a search — rather than
 * trusting this comment.
 *
 * Four entities, six branches, because two of them have alias tables:
 *
 * | entity           | primary                      | aliases                |
 * | ---------------- | ---------------------------- | ---------------------- |
 * | chip             | `chip.chip_id`, `display_name` | `chip_name.name`     |
 * | system           | `system.system_id`, `name`     | `system_name.name`   |
 * | machine          | `v_machine.machine_id`, `name` | —                    |
 * | implementation   | `implementation_id`, `name`    | —                    |
 *
 * Searching the alias tables is not a nicety. `chip_name` carries both `alias`
 * (a second name the part is sold under) and `retired_id` (an identifier that used
 * to be the primary key), and a retired id that no longer finds its chip is a dead
 * permalink — the alias mechanism in TASKS.md's standing rule 5 exists precisely so
 * that never happens.
 */

export const SEARCH_HIT_KINDS = ['chip', 'system', 'machine', 'implementation'] as const;
export type SearchHitKind = (typeof SEARCH_HIT_KINDS)[number];

export interface SearchHit {
  readonly kind: SearchHitKind;
  readonly id: string;
  readonly label: string;
  /** A short second line: manufacturer, system kind, driver file, implementation kind. */
  readonly detail: string | null;
  /** The alias that matched, when the hit came through an alias table. */
  readonly matched_on: string | null;
  /** 0 exact · 1 exact alias · 2 prefix · 3 alias prefix · 4 substring · 5 alias substring. */
  readonly rank: number;
}

/** How many hits of one kind may appear, so one entity cannot crowd out the rest. */
export const HITS_PER_KIND = 5;
/** How many hits in total. */
export const HITS_TOTAL = 20;

/**
 * Ranking, in the order the `CASE` expressions below assign it:
 *
 * 0. the id or the primary name *is* what was typed;
 * 1. an alias is what was typed — one step behind the primary name it belongs to;
 * 2. the id or primary name starts with it;
 * 3. an alias starts with it;
 * 4. the id or primary name contains it;
 * 5. an alias contains it.
 *
 * Ties break towards chips, then systems, then implementations, then machines
 * (`kind_rank DESC`): a search for `z80` wants the CPU above the 9 775 MAME sets
 * whose title happens to contain the string. Within one kind, shorter labels first
 * — `Z80` before `Z80 dev board`.
 *
 * The `ROW_NUMBER()` layers do two things a `GROUP BY` could not: collapse an
 * entity that matched both by name and by alias down to its single best row while
 * keeping which alias matched, and cap each kind at `:per_kind` so the dropdown is
 * always a mix.
 */
export const SEARCH_SQL = `
WITH q(needle, prefix, contains) AS (VALUES (:needle, :prefix, :contains))
SELECT kind, id, label, detail, matched_on, rank
FROM (
  SELECT ranked.*,
         ROW_NUMBER() OVER (PARTITION BY ranked.kind
                            ORDER BY ranked.rank, ranked.label_length, ranked.label, ranked.id)
           AS kind_row
  FROM (
    SELECT hit.*,
           ROW_NUMBER() OVER (PARTITION BY hit.kind, hit.id
                              ORDER BY hit.rank, hit.matched_on) AS entity_row
    FROM (
      SELECT 'chip' AS kind, 4 AS kind_rank, c.chip_id AS id, c.display_name AS label,
             length(c.display_name) AS label_length,
             COALESCE(c.manufacturer_id, c.function_id) AS detail,
             NULL AS matched_on,
             CASE WHEN lower(c.chip_id) = q.needle OR lower(c.display_name) = q.needle THEN 0
                  WHEN c.chip_id LIKE q.prefix ESCAPE '\\'
                    OR c.display_name LIKE q.prefix ESCAPE '\\' THEN 2
                  ELSE 4 END AS rank
      FROM chip c, q
      WHERE c.chip_id LIKE q.contains ESCAPE '\\' OR c.display_name LIKE q.contains ESCAPE '\\'

      UNION ALL
      SELECT 'chip', 4, n.chip_id, c.display_name, length(c.display_name),
             COALESCE(c.manufacturer_id, c.function_id), n.name,
             CASE WHEN lower(n.name) = q.needle THEN 1
                  WHEN n.name LIKE q.prefix ESCAPE '\\' THEN 3
                  ELSE 5 END
      FROM chip_name n JOIN chip c ON c.chip_id = n.chip_id, q
      WHERE n.name LIKE q.contains ESCAPE '\\'

      UNION ALL
      SELECT 'system', 3, s.system_id, s.name, length(s.name), s.kind_id, NULL,
             CASE WHEN lower(s.system_id) = q.needle OR lower(s.name) = q.needle THEN 0
                  WHEN s.system_id LIKE q.prefix ESCAPE '\\'
                    OR s.name LIKE q.prefix ESCAPE '\\' THEN 2
                  ELSE 4 END
      FROM system s, q
      WHERE s.system_id LIKE q.contains ESCAPE '\\' OR s.name LIKE q.contains ESCAPE '\\'

      UNION ALL
      SELECT 'system', 3, n.system_id, s.name, length(s.name), s.kind_id, n.name,
             CASE WHEN lower(n.name) = q.needle THEN 1
                  WHEN n.name LIKE q.prefix ESCAPE '\\' THEN 3
                  ELSE 5 END
      FROM system_name n JOIN system s ON s.system_id = n.system_id, q
      WHERE n.name LIKE q.contains ESCAPE '\\'

      UNION ALL
      SELECT 'implementation', 2, i.implementation_id, i.name, length(i.name), i.kind_id, NULL,
             CASE WHEN lower(i.implementation_id) = q.needle OR lower(i.name) = q.needle THEN 0
                  WHEN i.implementation_id LIKE q.prefix ESCAPE '\\'
                    OR i.name LIKE q.prefix ESCAPE '\\' THEN 2
                  ELSE 4 END
      FROM implementation i, q
      WHERE i.implementation_id LIKE q.contains ESCAPE '\\'
         OR i.name LIKE q.contains ESCAPE '\\'

      UNION ALL
      SELECT 'machine', 1, m.machine_id, m.name, length(m.name),
             COALESCE(m.system_id, m.mame_sourcefile), NULL,
             CASE WHEN lower(m.machine_id) = q.needle OR lower(m.name) = q.needle THEN 0
                  WHEN m.machine_id LIKE q.prefix ESCAPE '\\'
                    OR m.name LIKE q.prefix ESCAPE '\\' THEN 2
                  ELSE 4 END
      FROM v_machine m, q
      WHERE m.machine_id LIKE q.contains ESCAPE '\\' OR m.name LIKE q.contains ESCAPE '\\'
    ) hit
  ) ranked
  WHERE ranked.entity_row = 1
) capped
WHERE kind_row <= :per_kind
ORDER BY rank, kind_rank DESC, label_length, label, id
LIMIT :limit
`.trim();

/** Below this, every needle matches half the dataset and no result is useful. */
export const MIN_SEARCH_LENGTH = 2;

/**
 * The statement for one search term, or `undefined` when the term is too short to
 * be worth asking about — which is what keeps `query()` idle until it is.
 */
export function searchSpec(
  term: string,
  limits: { readonly perKind?: number; readonly total?: number } = {},
): QuerySpec | undefined {
  const needle = term.trim().toLowerCase();
  if (needle.length < MIN_SEARCH_LENGTH) {
    return undefined;
  }
  const escaped = escapeLikePattern(needle);
  return {
    sql: SEARCH_SQL,
    params: {
      ':needle': needle,
      ':prefix': `${escaped}%`,
      ':contains': `%${escaped}%`,
      ':per_kind': limits.perKind ?? HITS_PER_KIND,
      ':limit': limits.total ?? HITS_TOTAL,
    },
  };
}

/** What the router should do when a hit is opened. */
export interface SearchHitTarget {
  readonly link: readonly string[];
  readonly queryParams?: Readonly<Record<string, string>>;
}

/**
 * Where a hit goes.
 *
 * Chips, systems and machines have detail routes. **Implementations do not** —
 * PLAN §5 specifies a browser (T7.8) and no `/implementation/:id` page — so an
 * implementation hit lands on the browser carrying the id as
 * `?implementation=<id>`. T7.8 owns honouring that parameter; until it does, the
 * link still resolves to a real page rather than a 404.
 */
export function searchHitTarget(hit: Pick<SearchHit, 'kind' | 'id'>): SearchHitTarget {
  switch (hit.kind) {
    case 'chip':
      return { link: ['/chip', hit.id] };
    case 'system':
      return { link: ['/system', hit.id] };
    case 'machine':
      return { link: ['/machine', hit.id] };
    case 'implementation':
      return { link: ['/implementations'], queryParams: { implementation: hit.id } };
  }
}

const KIND_LABELS: Readonly<Record<SearchHitKind, string>> = {
  chip: 'Chip',
  system: 'System',
  machine: 'Machine',
  implementation: 'Implementation',
};

export function searchHitKindLabel(kind: SearchHitKind): string {
  return KIND_LABELS[kind];
}
