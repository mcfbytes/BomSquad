import { DOCUMENT, Component, inject, signal } from '@angular/core';
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

/**
 * The application shell: masthead, primary navigation, theme switch, footer.
 *
 * The masthead is one of exactly two elements allowed to carry the CRT texture
 * (the home hero is the other). Everything inside `<main>` is data, and data
 * gets no decoration.
 */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, ThemeToggle],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  private readonly document = inject(DOCUMENT);
  private readonly router = inject(Router);

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
  }

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
