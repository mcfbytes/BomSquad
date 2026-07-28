import type { Route } from '@angular/router';

import { routes } from './app.routes';

/** Every view PLAN §5 specifies, at the permalink shape it specifies. */
const REQUIRED_PATHS = [
  '', // 1. home / dashboard
  'chips', // 2. chip browser
  'chip/:chipId', // 3. chip detail
  'machines', // 4. machine browser
  'machine/:machineId', // 5. machine detail
  'systems', // 6a. platform-family index
  'system/:systemId', // 6b. platform-family view
  'prospector', // 7. the Prospector
  'implementations', // 8. implementation browser
  'contribute', // 9. contribute
] as const;

const lazyRoutes = (): readonly Route[] => routes.filter((route) => route.redirectTo === undefined);

describe('routes', () => {
  it('declares a route for every view in PLAN §5', () => {
    const paths = routes.map((route) => route.path);
    for (const path of REQUIRED_PATHS) {
      expect(paths).toContain(path);
    }
  });

  it('puts home first and the wildcard fallback last', () => {
    expect(routes.at(0)?.path).toBe('');
    expect(routes.at(-1)?.path).toBe('**');
  });

  it('lazily resolves every non-redirect route component', async () => {
    for (const route of lazyRoutes()) {
      expect(typeof route.loadComponent).toBe('function');
      await expect(route.loadComponent?.()).resolves.toBeDefined();
    }
  });

  it('gives every non-redirect route a page title', () => {
    for (const route of lazyRoutes()) {
      expect(typeof route.title).toBe('string');
    }
  });

  it("keeps PLAN §5's /family/:id permalink resolving, as a redirect to /system/:id", () => {
    const family = routes.find((route) => route.path === 'family/:systemId');

    expect(family?.redirectTo).toBe('system/:systemId');
    expect(family?.pathMatch).toBe('full');
  });
});
