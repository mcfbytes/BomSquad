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
