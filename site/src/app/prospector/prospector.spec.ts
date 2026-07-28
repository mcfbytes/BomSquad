import { Component } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, RouterOutlet, provideRouter, withComponentInputBinding } from '@angular/router';

import { provideFixtureDatabase } from '../../testing/database-testing';
import { routes } from '../app.routes';

/**
 * T7.7's acceptance criteria, as tests:
 *
 * - "deep links reproduce the exact filtered view" — every filter is read back off the
 *   URL after a cold navigation, including which breakdown is expanded;
 * - "score breakdown matches T6.3 data" — the rendered factors are the ones
 *   `ranking.spec.ts` pins against `pipeline/src/prospector/rank.ts`;
 * - and the constraint the task adds to them: the page must **show** the confidence
 *   level and the unmapped-device count, not merely apply them to the score.
 *
 * Rendered through the real `routes` and a real `<router-outlet>`, because
 * `withComponentInputBinding()` only binds query parameters to a component the *router*
 * created — `TestBed.createComponent(Prospector)` gets none of them, which would make
 * every assertion below a test of the default state.
 */

@Component({ selector: 'app-test-host', imports: [RouterOutlet], template: '<router-outlet />' })
class Host {}

async function navigate(url: string): Promise<ComponentFixture<Host>> {
  TestBed.configureTestingModule({
    providers: [
      ...provideFixtureDatabase().providers,
      provideRouter(routes, withComponentInputBinding()),
    ],
  });

  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  await TestBed.inject(Router).navigateByUrl(url);
  await settle(fixture);
  return fixture;
}

/** Change detection, the database download and the queries, until quiet. */
async function settle(fixture: ComponentFixture<Host>): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    fixture.detectChanges();
    await fixture.whenStable();
  }
  fixture.detectChanges();
}

function root(fixture: ComponentFixture<Host>): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

function boards(fixture: ComponentFixture<Host>): HTMLElement[] {
  return [...root(fixture).querySelectorAll<HTMLElement>('.board')];
}

/** The nth board, or a failure that names the missing row rather than a null deref. */
function board(fixture: ComponentFixture<Host>, index: number): HTMLElement {
  const found = boards(fixture)[index];
  if (found === undefined) {
    throw new Error(`no board rendered at index ${index}`);
  }
  return found;
}

/** A control the test drives, or a failure that names the selector. */
function control(fixture: ComponentFixture<Host>, selector: string): HTMLSelectElement {
  const found = root(fixture).querySelector<HTMLSelectElement>(selector);
  if (found === null) {
    throw new Error(`no control matched ${selector}`);
  }
  return found;
}

/** Templates wrap, so every text assertion compares collapsed whitespace. */
function squish(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function titles(fixture: ComponentFixture<Host>): string[] {
  return boards(fixture).map((board) => squish(board.querySelector('h2')?.textContent));
}

function url(): string {
  return TestBed.inject(Router).url;
}

describe('The Prospector', () => {
  it('ranks the platform’s core-less boards, highest first', async () => {
    const fixture = await navigate('/prospector');

    expect(titles(fixture)).toEqual(['Rank 1: Capcom CPS-1', 'Rank 2: Sega System 1']);
  });

  it('links every board to its own permalink', async () => {
    const fixture = await navigate('/prospector');
    const hrefs = boards(fixture).map((board) => board.querySelector('h2 a')?.getAttribute('href'));

    expect(hrefs).toEqual(['/system/capcom-cps1', '/system/sega-system1']);
  });

  it('shows the confidence level on the row, not only inside the score', async () => {
    const fixture = await navigate('/prospector');
    const tags = [...board(fixture, 1).querySelectorAll('.board__signals .tag')].map((tag) =>
      squish(tag.textContent),
    );

    expect(tags).toContain('medium confidence');
  });

  it('shows the unmapped-device count and says in words what it means', async () => {
    const fixture = await navigate('/prospector');
    const row = board(fixture, 1);

    // The badge on this row reads 3/3. Without the next two lines it reads "finished".
    expect(squish(row.textContent)).toContain('1 unmapped device');
    expect(squish(row.querySelector('.board__caveat')?.textContent)).toContain(
      'not catalogued yet',
    );
  });

  it('names the missing chips with their difficulty band, and links them', async () => {
    const fixture = await navigate('/prospector');
    const gap = boards(fixture)[0]?.querySelector('.chip-gap');

    expect(gap?.getAttribute('href')).toBe('/chip/sega-315-5011');
    expect(squish(gap?.textContent)).toContain('hard');
  });

  it('keeps the breakdown collapsed until it is asked for', async () => {
    const fixture = await navigate('/prospector');

    expect(root(fixture).querySelector('.breakdown')).toBeNull();
    expect(boards(fixture)[0]?.querySelector('button')?.getAttribute('aria-expanded')).toBe(
      'false',
    );
  });

  it('reproduces the exact score from the factors it renders', async () => {
    const fixture = await navigate('/prospector?open=sega-system1');
    const formula = squish(root(fixture).querySelector('.breakdown__formula')?.textContent);

    // ranking.spec.ts pins these against pipeline/src/prospector/rank.ts.
    expect(formula).toBe(
      '0.575385 = readiness 0.676923 × confidence 0.85 × system-mate 1 × CPU+sound 1',
    );
  });

  it('reproduces a filtered view from the URL alone', async () => {
    const fixture = await navigate('/prospector?platform=mister&manufacturer=sega');

    expect(titles(fixture)).toEqual(['Rank 2: Sega System 1']);
    // The rank belongs to the platform, so narrowing the list must not renumber it.
    expect(squish(root(fixture).querySelector('.board__rank')?.textContent)).toBe('#2');
  });

  it('writes a filter into the URL so the view can be shared', async () => {
    const fixture = await navigate('/prospector');
    const select = control(fixture, '#prospector-manufacturer');
    select.value = 'sega';
    select.dispatchEvent(new Event('change'));
    await settle(fixture);

    expect(url()).toBe('/prospector?manufacturer=sega');
    expect(titles(fixture)).toEqual(['Rank 2: Sega System 1']);
  });

  it('drops a filter from the URL rather than leaving it behind empty', async () => {
    const fixture = await navigate('/prospector?manufacturer=sega');
    const select = control(fixture, '#prospector-manufacturer');
    select.value = '';
    select.dispatchEvent(new Event('change'));
    await settle(fixture);

    expect(url()).toBe('/prospector');
  });

  it('puts the expanded breakdown in the URL, so a shared link opens it', async () => {
    const fixture = await navigate('/prospector');
    boards(fixture)[0]?.querySelector('button')?.click();
    await settle(fixture);

    expect(url()).toBe('/prospector?open=capcom-cps1');
    expect(root(fixture).querySelector('.breakdown')).not.toBeNull();
  });

  it('falls back to the default platform when a stale link names an unknown one', async () => {
    const fixture = await navigate('/prospector?platform=dreamcast');

    expect(squish(root(fixture).textContent)).toContain('MiSTer FPGA');
    expect(boards(fixture)).toHaveLength(2);
  });

  it('says so honestly when the filters match nothing', async () => {
    const fixture = await navigate('/prospector?q=nothing-matches-this');

    expect(boards(fixture)).toHaveLength(0);
    expect(squish(root(fixture).querySelector('.empty')?.textContent)).toContain(
      'matches these filters',
    );
  });
});
