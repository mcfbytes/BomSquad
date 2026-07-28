import { Component, computed, inject, output } from '@angular/core';

import { type ResolvedTheme, ThemeService } from './theme-service';

/**
 * The masthead's dark/light switch.
 *
 * The visible label names the *destination*, not the current state — "Light"
 * means "press me for light" — which is the least ambiguous phrasing for a
 * two-state control that has no room for a longer caption.
 *
 * The icons are inline 8x8 SVG sprites rather than ☀ / ☾. Those two codepoints
 * are outside the font subset, so they fell through to the Courier New fallback
 * at a different advance width, and U+263E has no glyph at all in several
 * Android system fonts — it renders as a replacement box. The brand mark was
 * moved off an emoji for exactly this reason; the toggle should not reintroduce
 * the dependency two lines later.
 */
@Component({
  selector: 'app-theme-toggle',
  template: `
    <button
      type="button"
      class="pixel-button theme-toggle"
      [attr.aria-label]="actionLabel()"
      (click)="toggle()"
    >
      @if (nextTheme() === 'light') {
        <svg class="theme-toggle__icon" viewBox="0 0 8 8" aria-hidden="true" focusable="false">
          <rect x="3" y="0" width="2" height="1" />
          <rect x="3" y="7" width="2" height="1" />
          <rect x="0" y="3" width="1" height="2" />
          <rect x="7" y="3" width="1" height="2" />
          <rect x="2" y="2" width="4" height="4" />
        </svg>
      } @else {
        <svg class="theme-toggle__icon" viewBox="0 0 8 8" aria-hidden="true" focusable="false">
          <rect x="2" y="1" width="4" height="1" />
          <rect x="1" y="2" width="3" height="4" />
          <rect x="2" y="6" width="4" height="1" />
        </svg>
      }
      <span class="theme-toggle__text" aria-hidden="true">{{ nextTheme() }}</span>
    </button>
  `,
  styles: `
    :host {
      display: inline-flex;
    }

    .theme-toggle {
      min-height: 2.25rem;
    }

    .theme-toggle__icon {
      flex: none;
      width: 1em;
      height: 1em;
      fill: var(--accent);
      /* Whole-pixel edges: these are 8x8 sprites, not icons. */
      shape-rendering: crispEdges;
    }

    .theme-toggle__text {
      min-width: 5ch;
      text-align: left;
    }
  `,
})
export class ThemeToggle {
  private readonly themeService = inject(ThemeService);

  /** Fires with the theme that is now on screen. The shell announces it. */
  readonly themeChange = output<ResolvedTheme>();

  readonly nextTheme = computed<ResolvedTheme>(() =>
    this.themeService.theme() === 'dark' ? 'light' : 'dark',
  );

  readonly actionLabel = computed(() => `Switch to the ${this.nextTheme()} theme`);

  toggle(): void {
    this.themeService.toggle();
    this.themeChange.emit(this.themeService.theme());
  }
}
