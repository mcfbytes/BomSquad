import { Component, input } from '@angular/core';

/**
 * The honest placeholder every unbuilt view renders.
 *
 * It states which task builds the view for real and lists what that view will
 * show, and it never fabricates a row, a count or a percentage — a fake number
 * on a data reference site is worse than an empty one.
 */
@Component({
  selector: 'app-placeholder-view',
  template: `
    <article class="view">
      <header class="view__head">
        <p class="eyebrow">{{ task() }}</p>
        <h1>{{ heading() }}</h1>
        @if (entityId(); as id) {
          <p class="view__id">
            Requested identifier: <code>{{ id }}</code>
          </p>
        }
        <p class="view__lede">{{ summary() }}</p>
      </header>

      <div class="panel view__notice">
        <h2>Not implemented yet</h2>
        <p>
          This is a routing placeholder from T7.1. Nothing on this page is data —
          {{ task() }} builds the real view against the shipped SQLite database.
        </p>
        @if (willShow().length > 0) {
          <h3>What lands here</h3>
          <ul>
            @for (item of willShow(); track item) {
              <li>{{ item }}</li>
            }
          </ul>
        }
      </div>

      <ng-content />
    </article>
  `,
  styles: `
    :host {
      display: block;
    }

    .view__head {
      max-width: 70ch;
      margin-bottom: 2rem;
    }

    .view__lede {
      font-size: 1.0625rem;
      color: var(--muted);
      margin-bottom: 0;
    }

    .view__id {
      font-size: 0.9375rem;
      color: var(--muted);
    }

    .view__id code {
      color: var(--fg);
      background: var(--surface-2);
      padding: 0.1em 0.4em;
      border: 1px solid var(--border);
    }

    .view__notice {
      max-width: 70ch;
      border-left-width: var(--px);
      border-left-color: var(--accent);
    }

    .view__notice > :last-child {
      margin-bottom: 0;
    }
  `,
})
export class PlaceholderView {
  /** The TASKS.md id that builds this view for real, e.g. `T7.4`. */
  readonly task = input.required<string>();
  readonly heading = input.required<string>();
  readonly summary = input.required<string>();
  /** Bullet list of what the finished view will show. */
  readonly willShow = input<readonly string[]>([]);
  /** The route parameter, echoed back so deep links are visibly working. */
  readonly entityId = input<string | null>(null);
}
