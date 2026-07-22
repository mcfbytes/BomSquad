# site

Angular 22 single-page application (SPA), deployed to Azure Static Web Apps. Purely client-side: lazy routes, signal-based data layer, typed data services generated from JSON Schemas. The browsable interface to the entire dataset with cross-linked views (chips, machines, families, implementations, cores) and the flagship **Prospector** ranked list of core-less boards.

See [PLAN.md §5](../PLAN.md#5-frontend-website) for the full page list and UX spec.

**Edit policy:** CODE. TypeScript + HTML templates, reviewed via PR. No backend; all data comes from `dist/site-data/` chunks fetched on demand. Changes here trigger a site redeploy via GitHub Actions.
