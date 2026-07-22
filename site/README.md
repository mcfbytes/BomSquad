# site

Angular 22 single-page application (SPA), deployed to Azure Static Web Apps. Purely client-side: lazy routes and signal-based stores. The browsable interface to the entire dataset with cross-linked views (chips, systems, machines, implementations) and the flagship **Prospector** ranked list of core-less boards.

There is no backend and no bespoke JSON API. The app downloads `dist/bomsquad.sqlite` once and queries it in the browser with `@sqlite.org/sqlite-wasm`, so every view is a SQL query against the same schema the pipeline builds — see [`docs/adr/0001-browser-database.md`](../docs/adr/0001-browser-database.md) for the decision and its measurements.

See [PLAN.md §5](../PLAN.md#5-frontend-website) for the full page list and UX spec.

**Edit policy:** CODE. TypeScript + HTML templates, reviewed via PR. Changes here trigger a site redeploy via GitHub Actions.
