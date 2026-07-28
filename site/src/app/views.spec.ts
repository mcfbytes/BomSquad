import { Component } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, RouterOutlet, provideRouter, withComponentInputBinding } from '@angular/router';

import { provideFixtureDatabase } from '../testing/database-testing';
import { routes } from './app.routes';

/**
 * T7.4–T7.6, T7.8 and T7.9 against the fixture database, through the real routes.
 *
 * What is asserted here is the part of each view that is a *claim about the data*:
 * that the rows are the ones the shipped views return, that a permalink resolves —
 * including through an alias or a retired identifier — and that an absent fact renders
 * as an honest gap rather than as a zero. Layout is not tested; the numbers are.
 *
 * The Prospector has its own file (`prospector/prospector.spec.ts`), because its
 * acceptance criteria are about the ranking rather than about rendering.
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
  for (let attempt = 0; attempt < 8; attempt += 1) {
    fixture.detectChanges();
    await fixture.whenStable();
  }
  fixture.detectChanges();
  return fixture;
}

function root(fixture: ComponentFixture<Host>): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

function squish(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function bodyText(fixture: ComponentFixture<Host>): string {
  return squish(root(fixture).textContent);
}

function rows(fixture: ComponentFixture<Host>): HTMLTableRowElement[] {
  return [...root(fixture).querySelectorAll<HTMLTableRowElement>('tbody tr')];
}

function cells(row: HTMLTableRowElement): string[] {
  return [...row.cells].map((cell) => squish(cell.textContent));
}

/** The nth data row, or a failure that names the missing row rather than a null deref. */
function row(fixture: ComponentFixture<Host>, index: number): HTMLTableRowElement {
  const found = rows(fixture)[index];
  if (found === undefined) {
    throw new Error(`no table row rendered at index ${index}`);
  }
  return found;
}

describe('chip browser (T7.4)', () => {
  it('lists every chip with its machine usage and FPGA status', async () => {
    const fixture = await navigate('/chips');
    const listed = rows(fixture).map((tr) => cells(tr)[0]);

    expect(listed).toHaveLength(5);
    // Default sort is machine usage, descending: z80 is in all three fixture machines.
    expect(listed[0]).toBe('Z80');
  });

  it('marks an uncovered chip as missing rather than leaving the cell blank', async () => {
    const fixture = await navigate('/chips?q=315');
    const found = cells(row(fixture, 0));

    expect(found[0]).toBe('Sega 315-5011');
    expect(found.at(-1)).toBe('missing');
  });

  it('distinguishes coverage through an equivalence from a direct implementation', async () => {
    const fixture = await navigate('/chips?q=z80a');

    expect(cells(row(fixture, 0)).at(-1)).toBe('via equivalent');
  });

  it('honours a status filter from the URL', async () => {
    const fixture = await navigate('/chips?status=missing');

    expect(rows(fixture).map((tr) => cells(tr)[0])).toEqual(['Sega 315-5011']);
  });
});

describe('chip detail (T7.4)', () => {
  it('shows specs, aliases, implementations and the machines that carry the part', async () => {
    const fixture = await navigate('/chip/z80');
    const text = bodyText(fixture);

    expect(root(fixture).querySelector('h1')?.textContent).toBe('Z80');
    expect(text).toContain('Zilog');
    expect(text).toContain('Z-80');
    expect(text).toContain('T80');
    expect(text).toContain('Wonder Boy');
  });

  it('records the equivalence claim and its note', async () => {
    const fixture = await navigate('/chip/z80');

    expect(bodyText(fixture)).toContain('Same core, higher clock rating.');
  });

  it('resolves a retired identifier instead of 404ing', async () => {
    const fixture = await navigate('/chip/zilog-z80');

    expect(root(fixture).querySelector('h1')?.textContent).toBe('Z80');
    expect(bodyText(fixture)).toContain('also known by');
  });

  it('says a chip has no implementation instead of showing an empty table', async () => {
    const fixture = await navigate('/chip/sega-315-5011');

    expect(bodyText(fixture)).toContain('Nothing in the catalogue implements this part');
  });

  it('renders an honest not-found page for an unknown permalink', async () => {
    const fixture = await navigate('/chip/does-not-exist');

    expect(root(fixture).querySelector('h1')?.textContent).toBe('No such chip');
  });
});

describe('machine browser (T7.5)', () => {
  it('lists machines with a coverage badge per row', async () => {
    const fixture = await navigate('/machines');
    const badges = [...root(fixture).querySelectorAll('.badge__counts')].map((badge) =>
      squish(badge.textContent),
    );

    expect(rows(fixture)).toHaveLength(3);
    expect(badges).toContain('3/4 chips');
  });

  it('filters by platform family from the URL', async () => {
    const fixture = await navigate('/machines?family=capcom-cps1');

    expect(rows(fixture).map((tr) => cells(tr)[0])).toEqual([
      'Street Fighter II: The World Warriorsf2',
    ]);
  });

  it('filters by whether a core exists', async () => {
    const fixture = await navigate('/machines?core=yes');

    // The fixture declares no implementation_machine or implementation_system rows.
    expect(rows(fixture)).toHaveLength(0);
    expect(bodyText(fixture)).toContain('No machine matches these filters');
  });
});

describe('machine detail (T7.5)', () => {
  it('renders the full BOM with a link or a missing badge on every row', async () => {
    const fixture = await navigate('/machine/sf2');
    const bom = rows(fixture).map((tr) => cells(tr));

    expect(bom).toHaveLength(4);
    expect(bom.some((cell) => cell.at(-1) === 'missing')).toBe(true);
    expect(bom.some((cell) => cell.at(-1)?.includes('FX68K') === true)).toBe(true);
  });

  it('says which sockets came from the family chipset rather than from MAME', async () => {
    const fixture = await navigate('/machine/sf2');
    const sources = rows(fixture).map((tr) => cells(tr).at(-2));

    expect(sources).toContain('chipset');
    expect(sources).toContain('MAME');
  });

  it('links the MAME driver at the pinned release', async () => {
    const fixture = await navigate('/machine/wboy');
    const driver = [...root(fixture).querySelectorAll('a')].find((link) =>
      link.textContent.includes('sega/system1.cpp'),
    );

    expect(driver?.getAttribute('href')).toBe(
      'https://github.com/mamedev/mame/blob/mame0999/src/mame/sega/system1.cpp',
    );
  });

  it('lists the uncatalogued devices the coverage badge cannot describe', async () => {
    const fixture = await navigate('/machine/zaxxon');
    const text = bodyText(fixture);

    expect(text).toContain('sn76496');
    expect(text).toContain('not mapped to a catalogued chip yet');
  });

  it('says when no core targets the machine', async () => {
    const fixture = await navigate('/machine/wboy');

    expect(bodyText(fixture)).toContain('No FPGA core in the catalogue targets this machine');
  });

  it('renders an honest not-found page for an unknown permalink', async () => {
    const fixture = await navigate('/machine/nosuchset');

    expect(root(fixture).querySelector('h1')?.textContent).toBe('No such machine');
  });
});

describe('platform family pages (T7.6)', () => {
  it('lists every family with its own coverage and confidence', async () => {
    const fixture = await navigate('/systems');
    const cards = [...root(fixture).querySelectorAll('.family')];

    expect(cards).toHaveLength(2);
    expect(squish(cards[0]?.textContent)).toContain('confidence');
  });

  it('shows the shared chipset, its provenance and the member machines', async () => {
    const fixture = await navigate('/system/capcom-cps1');
    const text = bodyText(fixture);

    expect(root(fixture).querySelector('h1')?.textContent).toBe('Capcom CPS-1');
    expect(text).toContain('curated');
    expect(text).toContain('Street Fighter II');
  });

  it('points at the Prospector for every platform that lacks a core', async () => {
    const fixture = await navigate('/system/capcom-cps1');
    const links = [...root(fixture).querySelectorAll('a')]
      .map((link) => link.getAttribute('href'))
      .filter((href) => href?.startsWith('/prospector'));

    expect(links).toContain('/prospector?platform=mister&q=capcom-cps1');
  });

  it('resolves a family alias', async () => {
    const fixture = await navigate('/system/cps-1');

    expect(root(fixture).querySelector('h1')?.textContent).toBe('Capcom CPS-1');
  });

  it('renders an honest not-found page for an unknown permalink', async () => {
    const fixture = await navigate('/system/nope');

    expect(root(fixture).querySelector('h1')?.textContent).toBe('No such platform family');
  });

  it('keeps PLAN §5’s /family/:id permalink working', async () => {
    const fixture = await navigate('/family/capcom-cps1');

    expect(root(fixture).querySelector('h1')?.textContent).toBe('Capcom CPS-1');
  });
});

describe('implementation browser (T7.8)', () => {
  it('lists implementations with licence and accuracy, flagging the unverified', async () => {
    const fixture = await navigate('/implementations');
    const listed = rows(fixture).map((tr) => cells(tr));

    expect(listed).toHaveLength(4);
    expect(listed.some((row) => row.includes('unverified'))).toBe(true);
  });

  it('filters by language from the URL', async () => {
    const fixture = await navigate('/implementations?language=vhdl');

    expect(rows(fixture).map((tr) => cells(tr)[0])).toEqual(['T80 t80']);
  });

  it('filters for the implementations nobody has licence-checked', async () => {
    const fixture = await navigate('/implementations?license=none');

    expect(rows(fixture).map((tr) => cells(tr)[0])).toEqual(['FX68K fx68k']);
  });

  it('expands the row a search hit links to, and shows what it covers', async () => {
    const fixture = await navigate('/implementations?implementation=jt51');
    const expansion = root(fixture).querySelector('.expansion');

    expect(expansion).not.toBeNull();
    expect(squish(expansion?.textContent)).toContain('YM2151');
  });
});

describe('dashboard (T7.9)', () => {
  it('queries every headline figure rather than hardcoding one', async () => {
    const fixture = await navigate('/');
    const stats = [...root(fixture).querySelectorAll('.stat')].map((stat) => ({
      value: squish(stat.querySelector('.stat__value')?.textContent),
      label: squish(stat.querySelector('.stat__label')?.textContent),
    }));

    expect(stats.find((stat) => stat.label.startsWith('Chips catalogued'))?.value).toBe('5');
    expect(stats.find((stat) => stat.label.startsWith('Machines tracked'))?.value).toBe('3');
    expect(stats.find((stat) => stat.label.startsWith('Platform families'))?.value).toBe('2');
  });

  it('shows the top newly-viable boards from the same ranking the Prospector uses', async () => {
    const fixture = await navigate('/');
    const board = root(fixture).querySelector('.viable__row');

    expect(squish(board?.textContent)).toContain('Capcom CPS-1');
    expect(squish(board?.querySelector('.viable__score')?.textContent)).toBe('0.643');
  });

  it('reports the dataset’s own quality figures live from the views', async () => {
    const fixture = await navigate('/');
    const text = bodyText(fixture);

    expect(text).toContain('MAPPED_INSTANCE_SHARE_LOW');
    expect(text).toContain('deliberately ignored');
  });

  it('says the quality report was not published rather than inventing a size', async () => {
    // The fixture fetch answers every URL with the database, so the report never parses
    // — which is exactly the shape of a deploy that forgot to publish it.
    const fixture = await navigate('/');

    expect(bodyText(fixture)).toContain('was not published with this build');
  });
});
