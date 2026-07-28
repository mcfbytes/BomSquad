/**
 * Puts the two runtime data assets where the built site can serve them.
 *
 *   node site/tools/stage-data-assets.mjs
 *
 * | asset                                             | staged to                        |
 * | ------------------------------------------------- | -------------------------------- |
 * | `dist/bomsquad.sqlite` (built by the pipeline)     | `site/public/site-data/`         |
 * | `@sqlite.org/sqlite-wasm`'s `sqlite3.wasm`        | `site/public/site-data/`         |
 *
 * **Why a copy step at all.** `dist/bomsquad.sqlite` is a build artifact of a
 * different workspace, outside `site/`, and gitignored — so it is not in the source
 * tree the Angular builder walks, and it does not exist at all in a fresh clone.
 * `angular.json` already copies `public/**` verbatim into the output, so staging
 * into `public/site-data/` is the whole integration: no new `assets` entry, no
 * Angular-specific configuration, and `ng serve` picks it up as well.
 *
 * **Why `/site-data/`.** `site/public/staticwebapp.config.json` already excludes
 * `/site-data/*` from the SPA navigation fallback. Anything served from anywhere
 * else — `/bomsquad.sqlite`, `/sqlite3.wasm` — would be rewritten to `index.html`
 * by Azure Static Web Apps, and the browser would try to open an HTML page as a
 * database and as WebAssembly respectively.
 *
 * **Missing database is not a build failure.** A site-only change, a fresh clone, a
 * docs PR: none of those have run the pipeline, and none of them should be blocked
 * from building the app. The build succeeds, the app boots, and the data layer
 * shows its "the database is not on the server" error state, which is exactly what
 * a real deploy with a broken pipeline step would show. What must not happen is a
 * *silent* success, so this prints a loud warning and CI is told to fail on it.
 */

import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(SITE_ROOT, '..');
const STAGE_DIR = join(SITE_ROOT, 'public/site-data');

const DATABASE_SOURCE = join(REPO_ROOT, 'dist/bomsquad.sqlite');
const WASM_SOURCE = fileURLToPath(import.meta.resolve('@sqlite.org/sqlite-wasm/sqlite3.wasm'));

function mib(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function stage(source, name) {
  const size = statSync(source).size;
  copyFileSync(source, join(STAGE_DIR, name));
  process.stdout.write(`stage-data-assets: /site-data/${name}  ${mib(size)}\n`);
}

function main(argv) {
  const strict = argv.includes('--require-database');

  mkdirSync(STAGE_DIR, { recursive: true });
  // Clean, so a renamed or withdrawn asset cannot survive in the deployed output.
  for (const entry of readdirSync(STAGE_DIR)) {
    rmSync(join(STAGE_DIR, entry), { recursive: true, force: true });
  }

  stage(WASM_SOURCE, 'sqlite3.wasm');

  try {
    stage(DATABASE_SOURCE, 'bomsquad.sqlite');
  } catch {
    const message =
      `stage-data-assets: ${DATABASE_SOURCE} is missing.\n` +
      '  The site will build, but every data view will render its "the database is not on the\n' +
      '  server" error state. Build it first with `npm run build --workspace pipeline`, or pass\n' +
      '  --require-database in CI to make this fatal.\n';
    process.stderr.write(message);
    if (strict) {
      process.exitCode = 1;
    }
  }
}

main(process.argv.slice(2));
