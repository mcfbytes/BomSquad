import { routes } from './app.routes';

describe('routes', () => {
  it('declares a lazy home route and a wildcard fallback', () => {
    expect(routes.at(0)?.path).toBe('');
    expect(routes.at(-1)?.path).toBe('**');
  });

  it('lazily resolves every route component', async () => {
    for (const route of routes) {
      expect(typeof route.loadComponent).toBe('function');
      await expect(route.loadComponent?.()).resolves.toBeDefined();
    }
  });
});
