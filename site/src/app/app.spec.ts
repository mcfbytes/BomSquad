import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { provideFixtureDatabase } from '../testing/database-testing';
import { App } from './app';
import { appConfig } from './app.config';

async function renderAt(url: string): Promise<ComponentFixture<App>> {
  const fixture = TestBed.createComponent(App);
  fixture.detectChanges();
  await TestBed.inject(Router).navigateByUrl(url);
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture;
}

/**
 * Boot the shell against the SHIPPED provider set, not a hand-rolled
 * `provideRouter(routes)`. A local router config silently omits
 * `withComponentInputBinding()`, so every detail route throws NG0950 under test
 * while working fine in production — which is exactly backwards from what a test
 * is for.
 *
 * The fixture database goes in for the same reason. Since T7.4–T7.9, every one of
 * these routes issues SQL on render, so a shell test without a database is really a
 * test of nine error states.
 */
function configure(): Promise<unknown> {
  localStorage.clear();
  return TestBed.configureTestingModule({
    imports: [App],
    providers: [...appConfig.providers, ...provideFixtureDatabase().providers],
  }).compileComponents();
}

describe('App shell', () => {
  beforeEach(async () => {
    await configure();
  });

  it('renders the masthead brand', async () => {
    const element: HTMLElement = (await renderAt('/')).nativeElement;
    expect(element.querySelector('.brand')?.textContent).toContain('BOM Squad');
  });

  it('links every primary view from the masthead', async () => {
    const element: HTMLElement = (await renderAt('/')).nativeElement;
    const hrefs = [...element.querySelectorAll('.nav__link')].map((link) =>
      link.getAttribute('href'),
    );

    expect(hrefs).toEqual([
      '/',
      '/chips',
      '/machines',
      '/systems',
      '/prospector',
      '/implementations',
      '/contribute',
    ]);
  });

  it('marks the current view with aria-current, not colour alone', async () => {
    const element: HTMLElement = (await renderAt('/machines')).nativeElement;
    const current = [...element.querySelectorAll('.nav__link')]
      .filter((link) => link.getAttribute('aria-current') === 'page')
      .map((link) => link.textContent.trim());

    expect(current).toEqual(['Machines']);
  });

  it('offers a labelled theme switch', async () => {
    const element: HTMLElement = (await renderAt('/')).nativeElement;
    const toggle: HTMLButtonElement | null = element.querySelector('.theme-toggle');

    expect(toggle?.getAttribute('aria-label')).toBe('Switch to the light theme');
  });

  it('has a live region for announcing theme and route changes', async () => {
    const element: HTMLElement = (await renderAt('/')).nativeElement;
    const status: HTMLElement | null = element.querySelector('[role="status"]');

    expect(status?.getAttribute('aria-live')).toBe('polite');
  });

  it('announces the new page and moves focus on a route change', async () => {
    const fixture = await renderAt('/');
    const element: HTMLElement = fixture.nativeElement;

    await TestBed.inject(Router).navigateByUrl('/prospector');
    await fixture.whenStable();
    fixture.detectChanges();

    expect(element.querySelector('[role="status"]')?.textContent).toContain('The Prospector');
    expect(document.activeElement).toBe(element.querySelector('#main'));
  });

  it('confines the CRT texture to the masthead and the home hero', async () => {
    // This used to assert `.crt` appeared exactly once — but it never navigated,
    // so the outlet was empty and it was really only counting the masthead. The
    // real dashboard has two.
    const home: HTMLElement = (await renderAt('/')).nativeElement;
    const textured = [...home.querySelectorAll('.crt')].map((node) => node.className);

    expect(textured).toEqual(['masthead crt', 'hero panel crt']);
  });

  it('puts no CRT texture on a data view', async () => {
    const machines: HTMLElement = (await renderAt('/machines')).nativeElement;
    const textured = [...machines.querySelectorAll('.crt')].map((node) => node.className);

    expect(textured).toEqual(['masthead crt']);
  });
});

describe('the skip link', () => {
  beforeEach(async () => {
    await configure();
  });

  it('exposes an in-page link as the first focusable element', async () => {
    const element: HTMLElement = (await renderAt('/')).nativeElement;
    const skip: HTMLAnchorElement | null = element.querySelector('.skip-link');

    expect(skip?.getAttribute('href')).toBe('#main');
  });

  it('gives the skip link a target that can actually take focus', async () => {
    const element: HTMLElement = (await renderAt('/')).nativeElement;
    expect(element.querySelector('#main')?.getAttribute('tabindex')).toBe('-1');
  });

  // The regression this replaces: `<base href="/">` makes a bare `#main` resolve
  // against the base URL, so activating the skip link on any route other than
  // `/` navigated the browser to `/#main` — a full reload onto the dashboard.
  // The old assertion only checked the href string, so it stayed green while the
  // feature was broken on nine routes out of ten.
  it.each(['/', '/machines', '/chip/ym2151', '/prospector'])(
    'moves focus to <main> without leaving %s',
    async (url) => {
      const fixture = await renderAt(url);
      const element: HTMLElement = fixture.nativeElement;
      const skip: HTMLAnchorElement | null = element.querySelector('.skip-link');
      const before = TestBed.inject(Router).url;

      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      skip?.dispatchEvent(event);
      await fixture.whenStable();
      fixture.detectChanges();

      expect(event.defaultPrevented).toBe(true);
      expect(TestBed.inject(Router).url).toBe(before);
      expect(document.activeElement).toBe(element.querySelector('#main'));
    },
  );
});
