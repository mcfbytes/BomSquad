import { Component } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';

import { type FetchLog, provideFixtureDatabase } from '../../testing/database-testing';
import { GlobalSearch } from './global-search';

/** Somewhere for the router to land, so activating a hit is a real navigation. */
@Component({ selector: 'app-blank', template: '' })
class Blank {}

let log: FetchLog;

function create(): ComponentFixture<GlobalSearch> {
  const fixture = provideFixtureDatabase({ debounceMs: 0 });
  log = fixture.log;
  TestBed.configureTestingModule({
    providers: [...fixture.providers, provideRouter([{ path: '**', component: Blank }])],
  });
  const component = TestBed.createComponent(GlobalSearch);
  component.detectChanges();
  return component;
}

/** Change detection plus the database download plus the query, until quiet. */
async function settle(fixture: ComponentFixture<GlobalSearch>): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    fixture.detectChanges();
    await fixture.whenStable();
  }
  fixture.detectChanges();
}

function root(fixture: ComponentFixture<GlobalSearch>): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

function field(fixture: ComponentFixture<GlobalSearch>): HTMLInputElement {
  const input = root(fixture).querySelector('input');
  if (input === null) {
    throw new Error('the search field did not render');
  }
  return input;
}

function hits(fixture: ComponentFixture<GlobalSearch>): HTMLAnchorElement[] {
  return [...root(fixture).querySelectorAll<HTMLAnchorElement>('.search__hit')];
}

async function type(fixture: ComponentFixture<GlobalSearch>, term: string): Promise<void> {
  const input = field(fixture);
  input.focus();
  input.value = term;
  input.dispatchEvent(new Event('input'));
  await settle(fixture);
}

function press(target: Element, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

describe('GlobalSearch', () => {
  it('is closed and silent before anything is typed', () => {
    const fixture = create();

    expect(fixture.nativeElement.querySelector('.search__panel')).toBeNull();
    expect(field(fixture).getAttribute('aria-expanded')).toBe('false');
    expect(log.calls).toEqual([]);
  });

  it('renders typed results with working links', async () => {
    const fixture = create();

    await type(fixture, 'z80');
    const links = hits(fixture);

    expect(links.length).toBeGreaterThan(0);
    expect(links[0]?.getAttribute('href')).toBe('/chip/z80');
    expect(links[0]?.textContent).toContain('Z80');
    expect(links[0]?.textContent).toContain('Chip');
  });

  it('links an implementation hit to the browser with its id as a query parameter', async () => {
    const fixture = create();

    await type(fixture, 'fx68');

    expect(hits(fixture)[0]?.getAttribute('href')).toBe('/implementations?implementation=fx68k');
  });

  it('shows the alias that matched, rather than pretending it was the name', async () => {
    const fixture = create();

    await type(fixture, 'cps-1');
    const text = hits(fixture)
      .map((link) => link.textContent)
      .join('\n');

    expect(text).toContain('Capcom CPS-1');
    expect(text).toContain('CPS-1');
  });

  it('says so when nothing matches, instead of showing an empty box', async () => {
    const fixture = create();

    await type(fixture, 'nothing-matches-this');

    expect(fixture.nativeElement.querySelector('.search__note')?.textContent).toContain('No chip');
  });

  it('announces the result count politely', async () => {
    const fixture = create();

    await type(fixture, 'z80');
    const summary = root(fixture).querySelector('#global-search-summary');

    expect(summary?.getAttribute('aria-live')).toBe('polite');
    expect(summary?.textContent.trim()).toMatch(/^\d+ results?\.$/);
  });
});

describe('the keyboard', () => {
  it('focuses the field when "/" is pressed anywhere on the page', () => {
    const fixture = create();
    const event = press(document.body, '/');

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(field(fixture));
  });

  it('leaves "/" alone while the visitor is typing in a field', () => {
    const fixture = create();
    const elsewhere = document.createElement('input');
    document.body.append(elsewhere);
    elsewhere.focus();

    const event = press(elsewhere, '/');

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
    expect(fixture.componentInstance).toBeDefined();
  });

  it('moves focus into the results with ArrowDown and back out with ArrowUp', async () => {
    const fixture = create();
    await type(fixture, 'z80');
    const links = hits(fixture);
    expect(links.length).toBeGreaterThan(1);

    press(field(fixture), 'ArrowDown');
    expect(document.activeElement).toBe(links[0]);

    press(links[0] as Element, 'ArrowDown');
    expect(document.activeElement).toBe(links[1]);

    press(links[1] as Element, 'ArrowUp');
    expect(document.activeElement).toBe(links[0]);

    press(links[0] as Element, 'ArrowUp');
    expect(document.activeElement).toBe(field(fixture));
  });

  it('wraps from the last result back to the first', async () => {
    const fixture = create();
    await type(fixture, 'z80');
    const links = hits(fixture);

    press(field(fixture), 'ArrowUp');
    expect(document.activeElement).toBe(links.at(-1));

    press(links.at(-1) as Element, 'ArrowDown');
    expect(document.activeElement).toBe(links[0]);
  });

  it('opens the first result on Enter', async () => {
    const fixture = create();
    await type(fixture, 'z80');

    press(field(fixture), 'Enter');
    await settle(fixture);

    expect(TestBed.inject(Router).url).toBe('/chip/z80');
  });

  it('closes on Escape and gives the caret back', async () => {
    const fixture = create();
    await type(fixture, 'z80');
    expect(fixture.nativeElement.querySelector('.search__panel')).not.toBeNull();

    press(field(fixture), 'Escape');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.search__panel')).toBeNull();
    expect(document.activeElement).toBe(field(fixture));
  });
});

describe('search runs against the database that is already open', () => {
  it('makes no second network request before or during the first search', async () => {
    const fixture = create();
    const originalFetch = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (input: RequestInfo | URL) => {
      seen.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      return Promise.reject(new Error('the search must not fetch anything'));
    };

    try {
      await type(fixture, 'z80');
      expect(hits(fixture).length).toBeGreaterThan(0);

      // The one request in the log is T7.2's single download of the whole
      // database (ADR 0001). Search adds nothing: no index, no per-entity JSON,
      // no range request. `globalThis.fetch` is never reached at all.
      expect(log.calls).toEqual(['/site-data/bomsquad.sqlite']);
      expect(seen).toEqual([]);

      await type(fixture, 'cps');
      await type(fixture, 'wonder');

      expect(log.calls).toHaveLength(1);
      expect(seen).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('starts the one download as soon as the field is focused', async () => {
    const fixture = create();

    field(fixture).focus();
    await settle(fixture);

    expect(log.calls).toEqual(['/site-data/bomsquad.sqlite']);
  });
});
