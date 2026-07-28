import { TestBed } from '@angular/core/testing';

import { provideFixtureDatabase } from '../../testing/database-testing';
import { DatabaseService } from '../data/database';
import { escapeLikePattern } from '../data/sql';
import { MIN_SEARCH_LENGTH, type SearchHit, searchHitTarget, searchSpec } from './search-query';

/**
 * T7.3's acceptance criterion — "fixture-database queries return correct typed
 * results with working links" — asserted against the real engine over the real
 * schema.
 */

async function search(term: string, limits?: Parameters<typeof searchSpec>[1]) {
  const database = TestBed.inject(DatabaseService);
  const spec = searchSpec(term, limits);
  if (spec === undefined) {
    return null;
  }
  return database.select<SearchHit>(spec.sql, spec.params);
}

function ids(hits: readonly SearchHit[] | null): readonly string[] {
  return (hits ?? []).map((hit) => `${hit.kind}:${hit.id}`);
}

describe('global search', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: provideFixtureDatabase().providers });
  });

  it('asks nothing until there is something to ask', () => {
    expect(searchSpec('')).toBeUndefined();
    expect(searchSpec(' ')).toBeUndefined();
    expect(searchSpec('z')).toBeUndefined();
    expect(searchSpec('z8')).toBeDefined();
    expect(MIN_SEARCH_LENGTH).toBe(2);
  });

  it('puts an exact id first', async () => {
    const hits = await search('z80');

    expect(hits?.[0]).toMatchObject({ kind: 'chip', id: 'z80', label: 'Z80', rank: 0 });
  });

  it('finds a chip by an alias in chip_name', async () => {
    // `Z-80` is not the display name and not the id; without the chip_name branch
    // this returns nothing at all.
    const hits = await search('z-80');

    expect(ids(hits)).toContain('chip:z80');
    expect(hits?.find((hit) => hit.id === 'z80')?.matched_on).toBe('Z-80');
    expect(hits?.find((hit) => hit.id === 'z80')?.label).toBe('Z80');
  });

  it('finds a chip by a retired id, so an old permalink still resolves', async () => {
    const hits = await search('zilog-z80');

    expect(ids(hits)).toEqual(['chip:z80']);
    expect(hits?.[0]?.matched_on).toBe('zilog-z80');
  });

  it('finds a system by an alias in system_name', async () => {
    const hits = await search('cps-1');

    expect(ids(hits)).toContain('system:capcom-cps1');
    expect(hits?.find((hit) => hit.id === 'capcom-cps1')).toMatchObject({
      label: 'Capcom CPS-1',
      matched_on: 'CPS-1',
      detail: 'arcade',
    });
  });

  it('searches machines and implementations too', async () => {
    expect(ids(await search('wonder'))).toEqual(['machine:wboy']);
    expect(ids(await search('fx68'))).toEqual(['implementation:fx68k']);
  });

  it('collapses an entity that matched twice into its best row', async () => {
    // `ym2151` matches both the primary name and nothing else; `opm` matches only
    // the alias. A search for the id must not return the chip twice.
    const hits = await search('ym2151');

    expect(ids(hits)).toEqual(['chip:ym2151']);
    expect(hits?.[0]?.matched_on).toBeNull();
  });

  it('ranks an exact alias above a prefix match on something else', async () => {
    const hits = await search('opm');

    expect(hits?.[0]).toMatchObject({ kind: 'chip', id: 'ym2151', matched_on: 'OPM', rank: 1 });
  });

  it('prefers chips over machines when both match equally well', async () => {
    const hits = (await search('z80')) ?? [];
    const firstMachine = hits.findIndex((hit) => hit.kind === 'machine');
    const lastChip = hits.map((hit) => hit.kind).lastIndexOf('chip');

    expect(lastChip).toBeGreaterThanOrEqual(0);
    if (firstMachine >= 0) {
      expect(lastChip).toBeLessThan(firstMachine);
    }
  });

  it('caps each kind, so one entity cannot fill the whole list', async () => {
    const uncapped = (await search('z8')) ?? [];
    expect(uncapped.filter((hit) => hit.kind === 'chip').length).toBeGreaterThan(1);

    const capped = (await search('z8', { perKind: 1, total: 10 })) ?? [];
    const perKind = new Map<string, number>();
    for (const hit of capped) {
      perKind.set(hit.kind, (perKind.get(hit.kind) ?? 0) + 1);
    }

    expect([...perKind.values()].every((count) => count <= 1)).toBe(true);
  });

  it('treats LIKE wildcards as literal text', async () => {
    // Without ESCAPE handling, `%` matches everything — a search for a percent
    // sign would return the whole catalogue.
    expect(escapeLikePattern('100%')).toBe('100\\%');
    expect(await search('100%')).toEqual([]);
    expect(await search('z_0')).toEqual([]);
  });

  it('is case insensitive in both directions', async () => {
    expect(ids(await search('WONDER BOY'))).toEqual(['machine:wboy']);
    expect(ids(await search('CPS-1'))).toContain('system:capcom-cps1');
    expect((await search('capcom cps-1'))?.[0]?.rank).toBe(0);
  });

  it('returns nothing rather than something wrong', async () => {
    expect(await search('definitely-not-in-the-dataset')).toEqual([]);
  });
});

describe('where a hit goes', () => {
  it('routes chips, systems and machines to their detail pages', () => {
    expect(searchHitTarget({ kind: 'chip', id: 'ym2151' }).link).toEqual(['/chip', 'ym2151']);
    expect(searchHitTarget({ kind: 'system', id: 'capcom-cps1' }).link).toEqual([
      '/system',
      'capcom-cps1',
    ]);
    expect(searchHitTarget({ kind: 'machine', id: 'sf2' }).link).toEqual(['/machine', 'sf2']);
  });

  it('routes an implementation to the browser, because it has no detail route', () => {
    // PLAN §5 specifies an implementation *browser* and no `/implementation/:id`
    // page, so this is a real constraint rather than an omission. T7.8 owns
    // honouring the query parameter; the link resolves to a real page either way.
    expect(searchHitTarget({ kind: 'implementation', id: 't80' })).toEqual({
      link: ['/implementations'],
      queryParams: { implementation: 't80' },
    });
  });
});
