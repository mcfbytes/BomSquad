/* Stamps the resolved theme onto <html> BEFORE first paint, so a visitor whose
 * stored preference disagrees with their OS never sees a flash of the wrong
 * theme while Angular boots.
 *
 * This is a separate file rather than an inline <script> because the production
 * CSP is `script-src 'self'` with no 'unsafe-inline'
 * (site/public/staticwebapp.config.json, owned by T7.11) — an inline script
 * would simply be blocked.
 *
 * The storage key and the value grammar are the contract with
 * site/src/app/theme/theme-service.ts. Keep them in step; theme-service.spec.ts
 * asserts they match.
 */
(function () {
  const KEY = 'bomsquad.theme';

  function storedMode() {
    try {
      return globalThis.localStorage.getItem(KEY);
    } catch {
      // Private mode, disabled storage, or a sandboxed iframe. Fall through to
      // the OS preference; a broken theme is not worth a broken page.
      return null;
    }
  }

  function systemMode() {
    // Dark is the default; a light OS preference is the only thing that
    // overrides it when the visitor has expressed nothing themselves.
    const query = globalThis.matchMedia && globalThis.matchMedia('(prefers-color-scheme: light)');
    return query && query.matches ? 'light' : 'dark';
  }

  const stored = storedMode();
  const mode = stored === 'dark' || stored === 'light' ? stored : systemMode();

  globalThis.document.documentElement.setAttribute('data-theme', mode);
})();
