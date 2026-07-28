import { TestBed } from '@angular/core/testing';

import { CoverageBadge } from './coverage-badge';

function render(covered: number | null, total: number | null): CoverageBadge {
  const fixture = TestBed.createComponent(CoverageBadge);
  fixture.componentRef.setInput('covered', covered);
  fixture.componentRef.setInput('total', total);
  fixture.detectChanges();
  return fixture.componentInstance;
}

describe('CoverageBadge', () => {
  it('renders PLAN §5’s example exactly', () => {
    const badge = render(9, 11);

    expect(badge.countsText()).toBe('9/11 chips');
    expect(badge.percentText()).toBe('82%');
    expect(badge.tone()).toBe('ok');
  });

  it('says it does not know rather than inventing a number', () => {
    const badge = render(null, null);

    expect(badge.percent()).toBeNull();
    expect(badge.countsText()).toBe('—/— chips');
    expect(badge.percentText()).toBe('—%');
    expect(badge.tone()).toBe('unknown');
  });

  it('treats a zero-length bill of materials as unknown, not as 0%', () => {
    const badge = render(0, 0);

    expect(badge.tone()).toBe('unknown');
  });

  it.each([
    [11, 11, 'ok'],
    [9, 11, 'ok'],
    [8, 10, 'ok'],
    [7, 10, 'warn'],
    [5, 10, 'warn'],
    [4, 10, 'bad'],
    [0, 10, 'bad'],
  ])('tones %i/%i as %s', (covered, total, tone) => {
    expect(render(covered, total).tone()).toBe(tone);
  });

  it('carries the same information in text as in colour', () => {
    const fixture = TestBed.createComponent(CoverageBadge);
    fixture.componentRef.setInput('covered', 9);
    fixture.componentRef.setInput('total', 11);
    fixture.detectChanges();

    const label: HTMLElement | null = fixture.nativeElement.querySelector('.sr-only');
    expect(label?.textContent).toBe('Coverage: 9 of 11 chips, 82 percent.');
  });
});
