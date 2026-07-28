# site

Angular 22 single-page application (SPA), deployed to Azure Static Web Apps. Purely client-side: lazy routes and signal-based stores. The browsable interface to the entire dataset with cross-linked views (chips, systems, machines, implementations) and the flagship **Prospector** ranked list of core-less boards.

There is no backend and no bespoke JSON API. The app downloads `dist/bomsquad.sqlite` once and queries it in the browser with `@sqlite.org/sqlite-wasm`, so every view is a SQL query against the same schema the pipeline builds — see [`docs/adr/0001-browser-database.md`](../docs/adr/0001-browser-database.md) for the decision and its measurements.

See [PLAN.md §5](../PLAN.md#5-frontend-website) for the full page list and UX spec.

**Edit policy:** CODE. TypeScript + HTML templates, reviewed via PR. Changes here trigger a site redeploy via GitHub Actions.

## Routes

One lazy route per PLAN §5 view, declared in [`src/app/app.routes.ts`](src/app/app.routes.ts). Detail
routes take their identifier as a component `input()` via `withComponentInputBinding()`.

| Path                  | View                           | Built for real by |
| --------------------- | ------------------------------ | ----------------- |
| `/`                   | Home / dashboard               | T7.9              |
| `/chips`              | Chip browser                   | T7.4              |
| `/chip/:chipId`       | Chip detail                    | T7.4              |
| `/machines`           | Machine browser                | T7.5              |
| `/machine/:machineId` | Machine detail (the BOM table) | T7.5              |
| `/systems`            | Platform-family index          | T7.6              |
| `/system/:systemId`   | Platform-family view           | T7.6              |
| `/family/:systemId`   | Redirect → `/system/:systemId` | —                 |
| `/prospector`         | The Prospector                 | T7.7              |
| `/implementations`    | Implementation browser         | T7.8              |
| `/contribute`         | Contribute                     | T8.1              |

`system` rather than `family` is canonical because that is what the schema calls the entity
(`schemas/schema.sql` → `CREATE TABLE system`); PLAN §5's `/family/…` shape redirects so older links
keep resolving.

The skip link and every route change hand focus to `<main>` from TypeScript, never through a fragment
href: `index.html` sets `<base href="/">`, so a bare `#main` resolves against the _base_ URL and
navigates `/chip/ym2151` to `/#main` — a full reload onto the dashboard. Route changes also announce
the new page title through the shell's polite live region.

Everything except `/` currently renders an honest `app-placeholder-view`: it names the task that
builds it and lists what will appear. **No placeholder invents data** — the dashboard's headline
figures are em dashes and the BOM table has one "no BOM loaded" row, because a plausible-looking fake
number on a data reference site is worse than an empty one.

## Theming

Dark by default (PLAN §5). Precedence, highest first: an explicit stored preference
(`localStorage['bomsquad.theme']`), then the OS's `prefers-color-scheme`, then dark.

- [`public/theme-init.js`](public/theme-init.js) stamps the resolved theme onto `<html data-theme>`
  **before first paint**, which is what prevents the flash of the wrong theme. It is a separate file
  rather than an inline `<script>` because the production CSP is `script-src 'self'` with no
  `'unsafe-inline'`, so an inline script would be blocked.
- [`src/app/theme/theme-service.ts`](src/app/theme/theme-service.ts) owns the same decision at
  runtime and tracks the OS live while the mode is `system`. Its spec asserts the two stay in step.
- The `<meta name="theme-color">` content is rewritten from the computed `--bg` on every theme
  change. It is deliberately **not** a pair of metas keyed on `prefers-color-scheme`: those describe
  the OS preference, so an OS-dark visitor who toggles to light gets a near-black mobile address bar
  over a cream page.

### The 8-bit arcade theme (T7.12)

A **token layer**, not a rewrite. The seven custom properties the original scaffold shipped
(`--bg`, `--surface`, `--border`, `--fg`, `--muted`, `--accent`, `--focus`) keep their names and their
meaning, so component styles inherit the theme without edits. New tokens were added; none renamed.

| File                                                         | Contains                                                                                                              |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| [`src/styles/_palette.scss`](src/styles/_palette.scss)       | Both palettes. The single source of colour truth.                                                                     |
| [`src/styles/_themes.scss`](src/styles/_themes.scss)         | Which palette applies, and when.                                                                                      |
| [`src/styles/_typography.scss`](src/styles/_typography.scss) | `@font-face`, the type scale, the pixel-face size floor.                                                              |
| [`src/styles/_base.scss`](src/styles/_base.scss)             | Element defaults.                                                                                                     |
| [`src/styles/_arcade.scss`](src/styles/_arcade.scss)         | CRT texture, panels, pixel buttons, the data zone.                                                                    |
| [`src/styles/_a11y.scss`](src/styles/_a11y.scss)             | Focus, `prefers-contrast`, `prefers-reduced-motion`. **Loaded last, and repeating the theme's selector specificity.** |

House rules, enforced by [`theme-assets.spec.ts`](src/app/theme/theme-assets.spec.ts) and
[`theme-cascade.spec.ts`](src/app/theme/theme-cascade.spec.ts):

- **The pixel face is chrome only, and never below 16px.** Press Start 2P draws on an 8-unit grid, so
  only multiples of 8px put a font pixel on a whole device pixel. The scale is 16 / 24 / 32 and
  nothing else — brand, `h1`–`h3`, stat readouts, and the full-size coverage badge. Chrome that has
  to be smaller (buttons, eyebrows, table-density badges, column headers) uses `m.chrome-label`:
  body sans, bold, tracked, uppercase.
- **Decoration is opt-in.** The arcade cap is `.pixel-button`, not the bare `button` element, so a
  sortable column header or a disclosure toggle inside a table cannot inherit it by accident. The
  only bare element selectors the theme layer sets are the data zone's plain defaults (`table`,
  `th`, `td`, `caption`, the zebra row).
- **The CRT texture is reachable only through `.crt`**, which the masthead and the home hero use and
  nothing else may. It paints _behind_ content, so it can never dim a glyph.
- **Contrast is computed, never eyeballed.**
  [`contrast.spec.ts`](src/app/theme/contrast.spec.ts) parses `_palette.scss` and asserts WCAG AA on
  every classified foreground/background pair in both themes — including the pairs sitting under the
  CRT texture, composited. A completeness check fails the suite if a new token is neither classified
  nor explicitly exempted.
- **The accessibility overrides are checked against the real cascade.** `theme-cascade.spec.ts`
  compiles `styles.scss` with Sass and resolves the winning declaration by specificity and source
  order — because the `prefers-contrast: more` overrides once shipped on a bare `:root` (0,1,0)
  against the theme's `:root[data-theme=…]` (0,2,0) and were silently dead. Grepping for the rule
  text passed; the feature did not work.

### The font

Self-hosted 2.3 kB subset of Press Start 2P (SIL OFL 1.1), regenerated by
[`tools/subset-font.py`](tools/subset-font.py). Provenance, the glyph coverage and the reason the
family is renamed are in [`public/fonts/README.md`](public/fonts/README.md). There is deliberately no
Google Fonts CDN link: the CSP is `font-src 'self' data:`.

## Build notes

`angular.json` disables **critical-CSS inlining** in the production configuration. Angular's inliner
emits `<link rel="stylesheet" media="print" onload="this.media='all'">`; the production CSP is
`script-src 'self'` with no `'unsafe-inline'`, so that inline handler never runs, the deferred
stylesheet is never promoted, and the site would render with only the above-the-fold slice of the
theme. One render-blocking 7 kB stylesheet is by far the cheaper trade.

## The data layer (T7.2)

Everything under [`src/app/data/`](src/app/data). Per
[ADR 0001](../docs/adr/0001-browser-database.md): **one `fetch` of the whole `dist/bomsquad.sqlite`,
opened in memory with `sqlite3_deserialize`.** No manifest, no chunking, no range requests, no OPFS
and therefore no COOP/COEP.

| File                                                          | What it is                                                                              |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [`sql.ts`](src/app/data/sql.ts)                               | `SqlEngine`, `QuerySpec`, `DatabaseLoadError`, `SqlQueryError`, `escapeLikePattern`.    |
| [`sqlite-wasm-engine.ts`](src/app/data/sqlite-wasm-engine.ts) | The only module that touches `@sqlite.org/sqlite-wasm`. Reached by dynamic import.      |
| [`database.ts`](src/app/data/database.ts)                     | `DatabaseService`: the one download, its progress, its failure, and `select()`.         |
| [`query.ts`](src/app/data/query.ts)                           | `query()` / `queryRow()` / `queryAll()` — reactive statements as Angular `resource()`s. |
| [`data-status.ts`](src/app/data/data-status.ts)               | `<app-data-status>`: the user-visible loading and error state.                          |
| `*.generated.ts`                                              | Row types. **Generated — do not edit.**                                                 |

### The seam T7.4–T7.9 use

```ts
import { query, type RowOf } from '../data/query';

const boards = query<RowOf<'v_prospector'>>(() => ({
  sql: 'SELECT * FROM v_prospector WHERE platform_id = :platform ORDER BY satisfied_share DESC',
  params: { ':platform': this.platform() },
}));
```

`boards` is a stock Angular `ResourceRef`: `.value()`, `.isLoading()`, `.error()`, `.status()`,
`.reload()`. Returning `undefined` from the spec function means "not yet" — the resource stays idle
instead of running a query with a half-resolved route parameter. Pair it with the shared status
component so a failure is never a blank page:

```html
<app-data-status
  [loading]="boards.isLoading()"
  [error]="boards.error()"
  (retry)="boards.reload()"
/>
```

Nothing blocks the app shell. `DatabaseService.preload()` is called by the shell once, at idle after
first render (and declines on a `saveData` connection); `ensureLoaded()` is idempotent and shares one
promise, so however many views ask, there is still exactly one request.

### Row types are generated, not written

`npm run codegen --workspace @bomsquad/site` runs
[`tools/generate-db-types.mjs`](tools/generate-db-types.mjs). It is wired into `prebuild`, and
[`schema-types.spec.ts`](src/app/data/schema-types.spec.ts) re-runs it in `--check` mode, so a change
to `schemas/` without a regeneration fails the test suite.

- **Tables** come from `schemas/*.schema.json` — the single source of truth TASKS.md T7.2 names. The
  generator refuses to guess: an unknown `$ref` fails the build. It also cross-checks each schema
  against the DDL (property names and order, JSON type against declared SQLite type, `required`
  against `NOT NULL`), because a JSON Schema that has quietly stopped describing its table is worse
  than no schema at all. Nullability is read off the **DDL**, not off `required`: a row file may omit
  `machine_chip.quantity` because it defaults to 1, and the column is still `NOT NULL` in the
  database.
- **Views have no JSON Schema, and SQLite exposes no usable type metadata for them.**
  `PRAGMA table_info` reports `notnull = 0` for every view column and gets the type wrong often
  enough to be dangerous — on the shipped database it calls `v_quality_warning.subject` and
  `v_system_chip_coverage.system_id` `BLOB`. So the view column **types** are declared once, in
  [`tools/view-column-types.mjs`](tools/view-column-types.mjs), while the column **names and order**
  come from the DDL and the generator fails if the two disagree. The declared types are then checked
  against data by [`view-types.spec.ts`](src/app/data/view-types.spec.ts), which reads every view of
  a fixture database and compares each value's storage class with what was declared.
- `threshold` is the one table with no JSON Schema (the loader writes it from `pipeline/config/`), so
  it is declared in the same file. The generator fails if a second table ever joins it silently.

### Tests run against a fixture database

[`src/testing/fixture-database.ts`](src/testing/fixture-database.ts) applies `schemas/schema.sql`
whole to a real SQLite file and seeds a small, deliberately awkward dataset — a chip with an alias
and a retired id, a system alias, an `equivalent` edge, a chip with no implementation, a machine in
no system, an implementation with no licence. The engine under test is the **real**
`@sqlite.org/sqlite-wasm`; only `fetch` is substituted.

### The database asset

`dist/bomsquad.sqlite` is a build artifact of another workspace, outside `site/` and gitignored, so
it is not in the tree the Angular builder walks. [`tools/stage-data-assets.mjs`](tools/stage-data-assets.mjs)
copies it — and `sqlite3.wasm` out of the installed package — into `public/site-data/`, which
`angular.json` already copies verbatim into the output. It runs from `prebuild`.

**`/site-data/` is not decoration.** `public/staticwebapp.config.json` already excludes
`/site-data/*` from the SPA navigation fallback; anything served from anywhere else would be
rewritten to `index.html`, and the browser would try to open an HTML page as a database and as
WebAssembly. That is also why `createSqliteWasmEngine` passes an explicit `locateFile` instead of
letting the library resolve `sqlite3.wasm` against `import.meta.url` (which after bundling is
`/sqlite3.wasm`, outside the exclusion).

**Build with `npm run build`, not bare `ng build`** — `ng build` skips `prebuild`, so the assets are
not staged and the deployed site shows its "the database is not on the server" error state. A missing
database is deliberately _not_ a build failure (a docs-only PR has not run the pipeline); pass
`--require-database` to `stage-data-assets.mjs` to make it fatal in CI.

### Global search (T7.3)

[`src/app/search/`](src/app/search). One SQL statement — [`search-query.ts`](src/app/search/search-query.ts) —
against the database T7.2 already opened. There is no search index and no second request: that is the
whole reason for shipping a relational engine to the browser, and `global-search.spec.ts` asserts it
by counting every `fetch` during a search.

It covers the alias tables (`chip_name`, `system_name`) as well as primary names, because
`chip_name` holds `retired_id` rows and a retired id that no longer finds its chip is a dead
permalink. Ranking is exact id / exact alias / prefix / alias prefix / substring / alias substring,
ties broken towards chips over systems over implementations over machines, and each kind is capped so
one entity cannot fill the list.

Keyboard: `/` focuses the field from anywhere, `ArrowDown` moves focus into the results, the arrows
walk and wrap, `Escape` closes and hands the caret back, `Enter` opens. Results are real
`<a routerLink>`s rather than the APG combobox pattern's non-focusable `role="option"` elements —
that keeps `Ctrl`/`Cmd`-click and middle-click working, which matters on a catalogue site, and the
`:focus-visible` ring the theme already defines does the highlighting.

Implementations have no detail route (PLAN §5 specifies a browser only), so an implementation hit
links to `/implementations?implementation=<id>`. **T7.8 owns honouring that parameter.**
