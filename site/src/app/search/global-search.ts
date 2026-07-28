import {
  Component,
  type ElementRef,
  InjectionToken,
  computed,
  effect,
  inject,
  linkedSignal,
  signal,
  viewChild,
  viewChildren,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import { DatabaseService } from '../data/database';
import { query } from '../data/query';
import {
  MIN_SEARCH_LENGTH,
  type SearchHit,
  searchHitKindLabel,
  searchHitTarget,
  searchSpec,
} from './search-query';

/**
 * How long typing has to pause before the statement runs.
 *
 * The query measures ~10 ms on the shipped database, so this is not about cost —
 * it is about not running fourteen statements while someone types "street fighter"
 * on a phone. Overridden to 0 in unit tests.
 */
export const SEARCH_DEBOUNCE_MS = new InjectionToken<number>('bomsquad.search-debounce-ms', {
  providedIn: 'root',
  factory: () => 120,
});

/**
 * Global search (T7.3).
 *
 * Lives in the app shell, so it is on every route, and it runs as SQL against the
 * database T7.2 already downloaded — **no second network request happens before or
 * during a search**, which is the task's acceptance criterion and which
 * `global-search.spec.ts` asserts by counting fetches.
 *
 * Keyboard model, deliberately made of real focus rather than
 * `aria-activedescendant`:
 *
 * - `/` anywhere on the page focuses the field (unless you are already typing
 *   somewhere).
 * - `ArrowDown` from the field moves focus to the first result; the arrows then
 *   walk the list and wrap.
 * - `Enter` on the field opens the first result; `Enter` on a result is just a link
 *   activation, so it is the browser's, which means `Ctrl`/`Cmd`-click and
 *   middle-click open in a new tab exactly as they should on a catalogue site.
 * - `Escape` closes the panel and returns focus to the field.
 *
 * Results are real `<a routerLink>`s for the same reason. The APG combobox pattern
 * would have made them non-focusable `role="option"` elements and taken
 * open-in-new-tab away; the focus ring the theme already defines
 * (`_a11y.scss`, `:focus-visible`) does the highlighting instead, and a polite live
 * region announces the result count.
 */
@Component({
  selector: 'app-global-search',
  imports: [RouterLink],
  host: {
    '(document:keydown)': 'onDocumentKeydown($event)',
    '(focusout)': 'onFocusOut($event)',
  },
  template: `
    <div class="search">
      <label class="sr-only" for="global-search-field"
        >Search chips, systems, machines and cores</label
      >
      <input
        #field
        id="global-search-field"
        class="search__field"
        type="search"
        autocomplete="off"
        spellcheck="false"
        placeholder="Search — press /"
        [attr.aria-expanded]="isOpen()"
        aria-controls="global-search-results"
        aria-describedby="global-search-summary"
        [value]="term()"
        (input)="onInput($event)"
        (keydown)="onFieldKeydown($event)"
        (focus)="onFocus()"
      />

      @if (isOpen()) {
        <div class="search__panel" id="global-search-results">
          @if (database.error(); as failure) {
            <p class="search__note search__note--error">
              Search needs the database, and it did not load. {{ failure.message }}
            </p>
          } @else if (results.error(); as failure) {
            <p class="search__note search__note--error">
              The search query failed: {{ failure.message }}
            </p>
          } @else if (isPending()) {
            <p class="search__note">{{ pendingLabel() }}</p>
          } @else if (hits().length === 0) {
            <p class="search__note">
              No chip, system, machine or core matches “{{ term().trim() }}”.
            </p>
          } @else {
            <ul class="search__list">
              @for (hit of hits(); track hit.kind + '/' + hit.id; let index = $index) {
                <li>
                  <a
                    #option
                    class="search__hit"
                    [routerLink]="target(hit).link"
                    [queryParams]="target(hit).queryParams ?? null"
                    (keydown)="onOptionKeydown($event, index)"
                    (click)="close()"
                  >
                    <span class="search__kind">{{ kindLabel(hit.kind) }}</span>
                    <span class="search__label">{{ hit.label }}</span>
                    @if (hit.matched_on; as alias) {
                      <span class="search__alias">also “{{ alias }}”</span>
                    }
                    @if (hit.detail; as detail) {
                      <span class="search__detail">{{ detail }}</span>
                    }
                  </a>
                </li>
              }
            </ul>
          }
        </div>
      }

      <!-- aria-live without role=status: the shell owns the single [role=status]
           region that announces theme and route changes, and a second one competes
           with it for the same announcement queue. -->
      <p class="sr-only" id="global-search-summary" aria-live="polite" aria-atomic="true">
        {{ summary() }}
      </p>
    </div>
  `,
  styles: `
    :host {
      display: block;
      flex: 1 1 18rem;
      max-width: 26rem;
    }

    .search {
      position: relative;
    }

    .search__field {
      width: 100%;
      padding: 0.45rem 0.6rem;
      font: inherit;
      font-size: 0.9375rem;
      color: var(--fg);
      background: var(--bg);
      border: var(--border-w) solid var(--border);
      border-radius: var(--radius);
    }

    .search__field::placeholder {
      color: var(--muted);
    }

    .search__panel {
      position: absolute;
      z-index: 20;
      top: calc(100% + 0.35rem);
      right: 0;
      left: 0;
      max-height: min(60vh, 30rem);
      overflow-y: auto;
      background: var(--surface);
      border: var(--border-w) solid var(--border-strong);
      border-radius: var(--radius);
      box-shadow: var(--shadow-pixel);
    }

    .search__note {
      margin: 0;
      padding: 0.75rem;
      color: var(--muted);
      font-size: 0.875rem;
    }

    .search__note--error {
      color: var(--bad);
    }

    .search__list {
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .search__list li + li {
      margin-top: 0;
      border-top: 1px solid var(--border);
    }

    .search__hit {
      display: grid;
      grid-template-columns: 7rem 1fr;
      gap: 0 0.6rem;
      padding: 0.5rem 0.75rem;
      color: var(--fg);
      text-decoration: none;
    }

    .search__hit:hover {
      background: var(--surface-2);
    }

    .search__kind {
      grid-row: 1 / span 2;
      align-self: start;
      font-size: var(--label-sm);
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--muted);
    }

    .search__label {
      font-size: 0.9375rem;
    }

    .search__alias,
    .search__detail {
      grid-column: 2;
      font-size: 0.8125rem;
      color: var(--muted);
    }

    @media (width <= 40rem) {
      :host {
        flex-basis: 100%;
        max-width: none;
      }
    }
  `,
})
export class GlobalSearch {
  protected readonly database = inject(DatabaseService);
  private readonly debounceMs = inject(SEARCH_DEBOUNCE_MS);

  private readonly field = viewChild.required<ElementRef<HTMLInputElement>>('field');
  private readonly options = viewChildren<ElementRef<HTMLAnchorElement>>('option');

  /** What is in the box right now. */
  protected readonly term = signal('');
  /** What the last statement was run for. */
  private readonly settledTerm = signal('');
  private readonly focused = signal(false);
  private readonly dismissed = signal(false);

  protected readonly results = query<SearchHit>(() => searchSpec(this.settledTerm()));

  protected readonly hits = computed(() => this.results.value());

  protected readonly isOpen = computed(
    () => this.focused() && !this.dismissed() && this.term().trim().length >= MIN_SEARCH_LENGTH,
  );

  /**
   * True while the first download is still in flight as well as while the
   * statement runs — from the visitor's side those are one wait, and splitting
   * them into two different spinners would be a lie about the architecture.
   */
  protected readonly isPending = computed(() => {
    if (this.database.isLoading() || this.database.status() === 'idle') {
      return true;
    }
    const status = this.results.status();
    return status === 'loading' || status === 'reloading' || this.settledTerm() !== this.term();
  });

  protected readonly pendingLabel = computed(() => {
    if (this.database.isReady()) {
      return 'Searching…';
    }
    const fraction = this.database.progressFraction();
    return fraction === null
      ? 'Downloading the database — search runs against it locally.'
      : `Downloading the database (${Math.round(fraction * 100)}%) — search runs against it locally.`;
  });

  protected readonly summary = computed(() => {
    if (!this.isOpen() || this.isPending()) {
      return '';
    }
    const count = this.hits().length;
    if (this.results.error() !== undefined || this.database.error() !== null) {
      return 'Search is unavailable.';
    }
    return count === 0 ? 'No results.' : `${count} result${count === 1 ? '' : 's'}.`;
  });

  /** Focus lands on the first hit whenever the result set changes. */
  private readonly activeIndex = linkedSignal<readonly SearchHit[], number>({
    source: () => this.hits(),
    computation: () => 0,
  });

  constructor() {
    // The debounce. `settledTerm` is what the query actually reads, so a burst of
    // keystrokes runs one statement rather than one per character.
    effect((onCleanup) => {
      const value = this.term();
      if (this.debounceMs <= 0) {
        this.settledTerm.set(value);
        return;
      }
      const handle = setTimeout(() => {
        this.settledTerm.set(value);
      }, this.debounceMs);
      onCleanup(() => {
        clearTimeout(handle);
      });
    });
  }

  protected kindLabel = searchHitKindLabel;
  protected target = searchHitTarget;

  protected onInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.term.set(input.value);
    this.dismissed.set(false);
  }

  protected onFocus(): void {
    this.focused.set(true);
    // The shell preloads at idle, but a visitor who reaches for search in the first
    // second beats it. Asking here means the one fetch starts either way — and it
    // is still one fetch, because `ensureLoaded()` shares its promise.
    void this.database.ensureLoaded().catch(() => undefined);
  }

  /** Closing on blur, except when focus moved to a result inside this component. */
  protected onFocusOut(event: FocusEvent): void {
    const next = event.relatedTarget;
    if (next instanceof Node && (event.currentTarget as Node).contains(next)) {
      return;
    }
    this.focused.set(false);
  }

  /** `/` focuses the field from anywhere that is not already a text field. */
  protected onDocumentKeydown(event: KeyboardEvent): void {
    if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    if (isTypingTarget(event.target)) {
      return;
    }
    event.preventDefault();
    this.focus();
  }

  protected onFieldKeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.focusOption(0);
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.focusOption(this.options().length - 1);
        break;
      case 'Enter': {
        const first = this.options()[0];
        if (first !== undefined) {
          event.preventDefault();
          first.nativeElement.click();
        }
        break;
      }
      case 'Escape':
        event.preventDefault();
        this.close();
        break;
      default:
        break;
    }
  }

  protected onOptionKeydown(event: KeyboardEvent, index: number): void {
    const count = this.options().length;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.focusOption((index + 1) % count);
        break;
      case 'ArrowUp':
        event.preventDefault();
        // Up from the first result goes back to the field, which is where the
        // caret was: a wrap to the bottom there feels like the page moved.
        if (index === 0) {
          this.focus();
        } else {
          this.focusOption(index - 1);
        }
        break;
      case 'Escape':
        event.preventDefault();
        this.close();
        break;
      default:
        break;
    }
  }

  /** Closes the panel and puts the caret back where the visitor left it. */
  protected close(): void {
    this.dismissed.set(true);
    this.focus();
  }

  private focus(): void {
    this.field().nativeElement.focus();
  }

  private focusOption(index: number): void {
    const option = this.options()[index];
    if (option === undefined) {
      return;
    }
    this.activeIndex.set(index);
    option.nativeElement.focus();
  }
}

/** Whether a keystroke belongs to whatever the visitor is already typing in. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
