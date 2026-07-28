import type { Routes } from '@angular/router';

/**
 * One lazy route per view in PLAN §5, using the permalink shapes that section
 * specifies. Every component is `loadComponent`-ed so a route only costs its
 * own chunk, and every detail route takes its identifier as a route parameter
 * bound straight to a component `input()` (see `withComponentInputBinding()` in
 * app.config.ts).
 *
 * Azure Static Web Apps rewrites unknown paths to `index.html`
 * (`site/public/staticwebapp.config.json`), so every path below survives a
 * refresh and is a real permalink.
 */
export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./home/home').then((m) => m.Home),
    title: 'BOM Squad',
  },
  {
    path: 'chips',
    loadComponent: () => import('./chips/chip-browser').then((m) => m.ChipBrowser),
    title: 'Chips · BOM Squad',
  },
  {
    path: 'chip/:chipId',
    loadComponent: () => import('./chips/chip-detail').then((m) => m.ChipDetail),
    title: 'Chip · BOM Squad',
  },
  {
    path: 'machines',
    loadComponent: () => import('./machines/machine-browser').then((m) => m.MachineBrowser),
    title: 'Machines · BOM Squad',
  },
  {
    path: 'machine/:machineId',
    loadComponent: () => import('./machines/machine-detail').then((m) => m.MachineDetail),
    title: 'Machine · BOM Squad',
  },
  {
    path: 'systems',
    loadComponent: () => import('./systems/system-browser').then((m) => m.SystemBrowser),
    title: 'Systems · BOM Squad',
  },
  {
    path: 'system/:systemId',
    loadComponent: () => import('./systems/system-detail').then((m) => m.SystemDetail),
    title: 'Platform family · BOM Squad',
  },
  // PLAN §5 writes the family permalink as `/family/sega-system16b`; the schema
  // calls the entity `system`, so `/system/…` is canonical and the older shape
  // redirects here rather than 404ing.
  { path: 'family/:systemId', redirectTo: 'system/:systemId', pathMatch: 'full' },
  {
    path: 'prospector',
    loadComponent: () => import('./prospector/prospector').then((m) => m.Prospector),
    title: 'The Prospector · BOM Squad',
  },
  {
    path: 'implementations',
    loadComponent: () =>
      import('./implementations/implementation-browser').then((m) => m.ImplementationBrowser),
    title: 'Implementations · BOM Squad',
  },
  {
    path: 'contribute',
    loadComponent: () => import('./contribute/contribute').then((m) => m.Contribute),
    title: 'Contribute · BOM Squad',
  },
  {
    path: '**',
    loadComponent: () => import('./not-found/not-found').then((m) => m.NotFound),
    title: 'Not found · BOM Squad',
  },
];
