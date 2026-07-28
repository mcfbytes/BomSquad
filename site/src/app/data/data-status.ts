import { Component, computed, input, output } from '@angular/core';

import { DatabaseLoadError, SqlQueryError } from './sql';

/**
 * The one place a data failure becomes something a person can read.
 *
 * T7.2's acceptance criterion is that "a failed database fetch or a query against a
 * missing view surfaces a user-visible error state, not a blank page", and this is
 * that state. It is shared by the app shell — which binds it to the single
 * `DatabaseService` download — and by every data view T7.4–T7.9 builds, which bind
 * it to their own query resource:
 *
 * ```html
 * <app-data-status [loading]="pending()" [error]="rows.error()" (retry)="rows.reload()" />
 * ```
 *
 * Deliberately quiet: it renders nothing at all when there is nothing to say, so
 * dropping it into a template costs nothing on the happy path.
 */
@Component({
  selector: 'app-data-status',
  template: `
    @if (error(); as failure) {
      <div class="status status--error" role="alert">
        <p class="status__headline">{{ headline() }}</p>
        <p class="status__detail">{{ failure.message }}</p>
        @if (hint(); as text) {
          <p class="status__hint">{{ text }}</p>
        }
        @if (statement(); as sql) {
          <pre class="status__sql"><code>{{ sql }}</code></pre>
        }
        <p class="status__actions">
          <button type="button" class="pixel-button" (click)="retry.emit()">Try again</button>
        </p>
      </div>
    } @else if (loading()) {
      <!-- aria-live without role=status on purpose: the shell already owns the one
           [role=status] region that announces theme and route changes, and a
           second one competes with it for the same announcement queue. -->
      <div class="status status--loading" aria-live="polite" aria-atomic="true">
        <p class="status__headline">{{ loadingLabel() }}</p>
        @if (fraction(); as value) {
          <progress class="status__bar" max="1" [value]="value">{{ percentText() }}</progress>
        }
        <p class="status__detail">{{ progressText() }}</p>
      </div>
    }
  `,
  styles: `
    :host {
      display: block;
    }

    .status {
      padding: 0.75rem 1rem;
      background: var(--surface);
      border: var(--px) solid var(--border);
      border-radius: var(--radius);
    }

    .status--error {
      border-color: var(--bad);
      border-left-width: calc(var(--px) * 3);
    }

    .status__headline {
      margin: 0;
      font-family: var(--font-body);
      font-size: var(--label-md);
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }

    .status__detail,
    .status__hint {
      margin: 0.35rem 0 0;
      font-size: 0.9375rem;
      color: var(--muted);
    }

    .status__hint {
      color: var(--fg);
    }

    .status__sql {
      margin: 0.5rem 0 0;
      padding: 0.5rem 0.65rem;
      overflow-x: auto;
      font-size: 0.8125rem;
      background: var(--surface-2);
      border: 1px solid var(--border);
    }

    .status__actions {
      margin: 0.75rem 0 0;
    }

    /* No animation anywhere: the bar is determinate when we know the total and
       absent when we do not, so there is nothing for prefers-reduced-motion to
       switch off. An indeterminate <progress> animates in every engine. */
    .status__bar {
      display: block;
      width: 100%;
      max-width: 32rem;
      height: 0.5rem;
      margin-top: 0.5rem;
      appearance: none;
      background: var(--surface-2);
      border: 1px solid var(--border);
    }

    .status__bar::-webkit-progress-bar {
      background: var(--surface-2);
    }

    .status__bar::-webkit-progress-value {
      background: var(--accent);
    }

    .status__bar::-moz-progress-bar {
      background: var(--accent);
    }
  `,
})
export class DataStatus {
  readonly loading = input(false);
  readonly error = input<Error | null | undefined>(null);
  /** Download progress in [0, 1], or `null` when the total size is unknown. */
  readonly fraction = input<number | null>(null);
  readonly receivedBytes = input<number | null>(null);
  readonly totalBytes = input<number | null>(null);
  readonly loadingLabel = input('Loading the database…');

  readonly retry = output();

  protected readonly headline = computed(() => {
    const failure = this.error();
    if (failure instanceof DatabaseLoadError) {
      return failure.kind === 'http'
        ? 'The database is not on the server'
        : 'The database failed to load';
    }
    return failure instanceof SqlQueryError ? 'That query failed' : 'Something went wrong';
  });

  /**
   * What the visitor can actually do about it. The three `DatabaseLoadError` kinds
   * have different answers, and "try again" is only one of them.
   */
  protected readonly hint = computed<string | null>(() => {
    const failure = this.error();
    if (failure instanceof DatabaseLoadError) {
      switch (failure.kind) {
        case 'network':
          return 'Check your connection and try again — the whole dataset is one download, so it needs to complete.';
        case 'http':
          return 'This is a deployment problem, not something you can fix from here. Please report it.';
        case 'engine':
          return 'Your browser could not open the file. WebAssembly has to be available and not blocked.';
      }
    }
    if (failure instanceof SqlQueryError) {
      return 'This is a bug in the page, not in your query. Please report it with the statement below.';
    }
    return null;
  });

  /** The offending statement, so a bug report can carry it. */
  protected readonly statement = computed<string | null>(() => {
    const failure = this.error();
    return failure instanceof SqlQueryError ? failure.sql : null;
  });

  protected readonly percentText = computed(() => {
    const value = this.fraction();
    return value === null ? '' : `${Math.round(value * 100)}%`;
  });

  protected readonly progressText = computed(() => {
    const received = this.receivedBytes();
    if (received === null) {
      return 'The whole dataset downloads once, then every page is a local SQL query.';
    }
    const total = this.totalBytes();
    const suffix = total === null ? '' : ` of ${formatBytes(total)}`;
    return `${formatBytes(received)}${suffix} — the whole dataset downloads once, then every page is a local SQL query.`;
  });
}

const MIB = 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes < MIB) {
    return `${Math.round(bytes / 1024)} kB`;
  }
  return `${(bytes / MIB).toFixed(1)} MB`;
}
