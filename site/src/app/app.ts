import { DOCUMENT, Component, DestroyRef, afterNextRender, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  type ActivatedRouteSnapshot,
  NavigationEnd,
  Router,
  RouterLink,
  RouterLinkActive,
  RouterOutlet,
} from '@angular/router';
import { filter } from 'rxjs';

import { DataStatus } from './data/data-status';
import { DatabaseService } from './data/database';
import { GlobalSearch } from './search/global-search';
import type { ResolvedTheme } from './theme/theme-service';
import { ThemeToggle } from './theme/theme-toggle';

interface NavLink {
  readonly path: string;
  readonly label: string;
  /** `/` matches everything as a prefix, so only the dashboard needs exact. */
  readonly exact: boolean;
}

/** The element the skip link and every route change hand focus to. */
const MAIN_ID = 'main';

/** Stand-in for `requestIdleCallback` where it does not exist. */
const IDLE_FALLBACK_MS = 1500;

/**
 * The application shell: masthead, primary navigation, theme switch, footer.
 *
 * The masthead is one of exactly two elements allowed to carry the CRT texture
 * (the home hero is the other). Everything inside `<main>` is data, and data
 * gets no decoration.
 */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, ThemeToggle, GlobalSearch, DataStatus],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  private readonly document = inject(DOCUMENT);
  private readonly router = inject(Router);

  /** Read by the template for the one load-state strip the whole app shares. */
  protected readonly database = inject(DatabaseService);

  protected readonly navLinks: readonly NavLink[] = [
    { path: '/', label: 'Dashboard', exact: true },
    { path: '/chips', label: 'Chips', exact: false },
    { path: '/machines', label: 'Machines', exact: false },
    { path: '/systems', label: 'Systems', exact: false },
    { path: '/prospector', label: 'Prospector', exact: false },
    { path: '/implementations', label: 'Implementations', exact: false },
    { path: '/contribute', label: 'Contribute', exact: false },
  ];

  /**
   * Read out by the polite live region: a theme flip and a route change are both
   * large, silent visual changes in a single-page app.
   */
  protected readonly announcement = signal('');

  /** The first NavigationEnd is the page load, which the browser announces itself. */
  private navigated = false;

  constructor() {
    this.router.events
      .pipe(
        filter((event) => event instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(() => {
        this.onNavigationEnd();
      });

    this.schedulePreload();
  }

  /**
   * Starts the 5.7 MB download once the shell has painted and the browser is idle.
   *
   * Deliberately not part of bootstrap: routes that need no data — `/contribute`,
   * `/`, a 404 — render completely without it, and the app shell never waits on a
   * network request it does not need. Search lives in the masthead and is therefore
   * reachable from every route, so starting the fetch speculatively is the right
   * trade; `DatabaseService.preload()` still declines on a save-data connection,
   * and `ensureLoaded()` shares one promise, so this can never become a second
   * fetch.
   */
  private schedulePreload(): void {
    const view = this.document.defaultView;
    if (view === null) {
      return;
    }
    const destroyRef = inject(DestroyRef);

    // lib.dom declares requestIdleCallback unconditionally; Safari only shipped it
    // in 18 and jsdom does not have it at all, so it is read off an optional shape.
    // The setTimeout branch is also what makes this inert under test: no unit test
    // runs for a second and a half.
    const idleView = view as unknown as {
      requestIdleCallback?: (callback: () => void) => number;
      cancelIdleCallback?: (handle: number) => void;
    };

    afterNextRender(() => {
      const start = (): void => {
        this.database.preload();
      };

      if (typeof idleView.requestIdleCallback === 'function') {
        const handle = idleView.requestIdleCallback(start);
        this.cancelPreload = () => {
          idleView.cancelIdleCallback?.(handle);
        };
        return;
      }

      const handle = view.setTimeout(start, IDLE_FALLBACK_MS);
      this.cancelPreload = () => {
        view.clearTimeout(handle);
      };
    });

    destroyRef.onDestroy(() => {
      this.cancelPreload?.();
      this.cancelPreload = null;
    });
  }

  private cancelPreload: (() => void) | null = null;

  /**
   * The skip link cannot be a plain `href="#main"`.
   *
   * `index.html` sets `<base href="/">`, and a fragment-only href resolves
   * against the *base* URL rather than the current one — so on `/chip/ym2151`
   * the browser treats it as a navigation to `/#main` and reloads the whole app
   * onto the dashboard. That broke the one control that exists specifically for
   * keyboard and screen-reader users, on nine routes out of ten. Handling the
   * activation here keeps the route, moves focus for real, and pushes no history
   * entry. The `href` stays so assistive tech still announces an in-page link.
   */
  protected skipToContent(event: Event): void {
    event.preventDefault();
    this.focusMain();
  }

  protected announceTheme(theme: ResolvedTheme): void {
    this.announcement.set(theme === 'dark' ? 'Dark theme enabled.' : 'Light theme enabled.');
  }

  private onNavigationEnd(): void {
    if (!this.navigated) {
      this.navigated = true;
      return;
    }
    // A router navigation swaps the page out without telling assistive tech
    // anything: focus stays on the link that was activated and nothing is spoken.
    this.announcement.set(`${this.activatedTitle()} — page loaded.`);
    this.focusMain();
  }

  /**
   * The title of the route that just activated.
   *
   * Read off the route snapshot rather than `Title.getTitle()`: the router
   * applies the document title from its *own* `NavigationEnd` subscriber, and
   * nothing orders that ahead of this one — reading the document title here
   * announced the previous page roughly half the time.
   */
  private activatedTitle(): string {
    let route: ActivatedRouteSnapshot = this.router.routerState.snapshot.root;
    while (route.firstChild !== null) {
      route = route.firstChild;
    }
    return route.title ?? this.document.title;
  }

  private focusMain(): void {
    this.document.getElementById(MAIN_ID)?.focus();
  }
}
