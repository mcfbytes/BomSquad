import { type ComponentFixture, TestBed } from '@angular/core/testing';

import { DataStatus } from './data-status';
import { DatabaseLoadError, SqlQueryError } from './sql';

/**
 * "A failed database fetch or a query against a missing view surfaces a
 * user-visible error state, not a blank page" is the acceptance criterion; this is
 * the component that has to hold it up, so the assertions are about what a person
 * actually reads on screen.
 */

function render(inputs: Partial<Record<string, unknown>>): ComponentFixture<DataStatus> {
  TestBed.configureTestingModule({});
  const fixture = TestBed.createComponent(DataStatus);
  for (const [name, value] of Object.entries(inputs)) {
    fixture.componentRef.setInput(name, value);
  }
  fixture.detectChanges();
  return fixture;
}

function text(fixture: ComponentFixture<DataStatus>): string {
  return (fixture.nativeElement as HTMLElement).textContent.replaceAll(/\s+/g, ' ').trim();
}

describe('DataStatus', () => {
  it('renders nothing when there is nothing to say', () => {
    expect(text(render({}))).toBe('');
  });

  it('shows determinate progress while the one download runs', () => {
    const fixture = render({
      loading: true,
      fraction: 0.42,
      receivedBytes: 2_400_000,
      totalBytes: 5_700_000,
    });
    const bar: HTMLProgressElement | null = fixture.nativeElement.querySelector('progress');

    expect(bar?.value).toBeCloseTo(0.42, 5);
    expect(text(fixture)).toContain('2.3 MB of 5.4 MB');
    expect(text(fixture)).toContain('downloads once');
  });

  it('still says something useful when the size is unknown', () => {
    const fixture = render({ loading: true, fraction: null, receivedBytes: null });

    expect(fixture.nativeElement.querySelector('progress')).toBeNull();
    expect(text(fixture)).toContain('Loading the database');
  });

  it('names the deployment problem when the server has no database', () => {
    const fixture = render({
      error: new DatabaseLoadError(
        'http',
        '/site-data/bomsquad.sqlite',
        'The server answered 404.',
      ),
    });

    expect(fixture.nativeElement.querySelector('[role="alert"]')).not.toBeNull();
    expect(text(fixture)).toContain('The database is not on the server');
    expect(text(fixture)).toContain('The server answered 404.');
    expect(text(fixture)).toContain('deployment problem');
  });

  it('tells an offline visitor to try again, and gives them the button', () => {
    const fixture = render({
      error: new DatabaseLoadError('network', '/site-data/bomsquad.sqlite', 'Failed to fetch.'),
    });
    let retried = 0;
    fixture.componentInstance.retry.subscribe(() => {
      retried += 1;
    });

    expect(text(fixture)).toContain('Check your connection');
    (fixture.nativeElement.querySelector('button') as HTMLButtonElement).click();

    expect(retried).toBe(1);
  });

  it('quotes the failing statement so a bug report can carry it', () => {
    const fixture = render({
      error: new SqlQueryError('SELECT * FROM v_typo', 'no such table: v_typo'),
    });

    expect(text(fixture)).toContain('That query failed');
    expect(text(fixture)).toContain('no such table: v_typo');
    expect(fixture.nativeElement.querySelector('code')?.textContent).toBe('SELECT * FROM v_typo');
  });

  it('prefers the error over the spinner when both are set', () => {
    const fixture = render({ loading: true, error: new Error('boom') });

    expect(fixture.nativeElement.querySelector('progress')).toBeNull();
    expect(text(fixture)).toContain('Something went wrong');
  });
});
