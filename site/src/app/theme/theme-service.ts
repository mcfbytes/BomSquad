import { DOCUMENT, Injectable, computed, effect, inject, signal } from '@angular/core';

/** What the visitor asked for. `system` means "follow the OS". */
export const THEME_MODES = ['system', 'dark', 'light'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

/** What actually gets painted. `system` has been resolved away. */
export type ResolvedTheme = 'dark' | 'light';

/**
 * Shared with `public/theme-init.js`, which reads the same key before first
 * paint to avoid a flash of the wrong theme. Changing it here means changing it
 * there; `theme-service.spec.ts` asserts the two agree.
 */
export const THEME_STORAGE_KEY = 'bomsquad.theme';

/** The query the default falls back to. Dark wins unless the OS asks for light. */
export const LIGHT_SCHEME_QUERY = '(prefers-color-scheme: light)';

function isThemeMode(value: string | null): value is ThemeMode {
  return value !== null && (THEME_MODES as readonly string[]).includes(value);
}

/**
 * Owns the dark/light decision.
 *
 * Precedence, highest first: an explicit stored preference, then the OS's
 * `prefers-color-scheme`, then dark (PLAN §5 — know the audience). While the
 * mode is `system` the OS is tracked live, so changing the OS theme in another
 * window flips the site without a reload.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly document = inject(DOCUMENT);

  private readonly storedMode = signal<ThemeMode>('system');
  private readonly systemPrefersLight = signal(false);

  /** What the visitor asked for — `system` until they touch the toggle. */
  readonly mode = this.storedMode.asReadonly();

  /** What is painted right now. */
  readonly theme = computed<ResolvedTheme>(() => {
    const mode = this.storedMode();
    if (mode !== 'system') {
      return mode;
    }
    return this.systemPrefersLight() ? 'light' : 'dark';
  });

  constructor() {
    const stored = this.readStoredMode();
    if (stored !== null) {
      this.storedMode.set(stored);
    }
    this.watchSystemPreference();

    effect(() => {
      const theme = this.theme();
      this.document.documentElement.setAttribute('data-theme', theme);
      this.syncThemeColor();
    });
  }

  /** Flip to the opposite of whatever is on screen, and remember it. */
  toggle(): void {
    this.setMode(this.theme() === 'dark' ? 'light' : 'dark');
  }

  /** Set an explicit mode; `system` clears the stored preference. */
  setMode(mode: ThemeMode): void {
    this.storedMode.set(mode);
    this.persist(mode);
  }

  private persist(mode: ThemeMode): void {
    const storage = this.storage();
    if (storage === null) {
      return;
    }
    try {
      if (mode === 'system') {
        storage.removeItem(THEME_STORAGE_KEY);
      } else {
        storage.setItem(THEME_STORAGE_KEY, mode);
      }
    } catch {
      // Storage can be full, disabled, or blocked in a sandboxed iframe. The
      // theme still applies for this page view; it just will not survive a
      // reload. That is not worth throwing over.
    }
  }

  private readStoredMode(): ThemeMode | null {
    const storage = this.storage();
    if (storage === null) {
      return null;
    }
    try {
      const value = storage.getItem(THEME_STORAGE_KEY);
      return isThemeMode(value) ? value : null;
    } catch {
      return null;
    }
  }

  private storage(): Storage | null {
    return this.document.defaultView?.localStorage ?? null;
  }

  /**
   * Repaint the mobile address bar to match the page.
   *
   * `index.html` used to carry two `theme-color` metas keyed on
   * `prefers-color-scheme`, which meant they described the *OS* preference and
   * went stale the moment the visitor used the toggle: OS-dark plus
   * toggle-to-light left a near-black address bar above a cream page.
   *
   * The value is read back out of the cascade rather than duplicated here, so
   * `--bg` in _palette.scss stays the single source of colour truth and this
   * cannot drift.
   */
  private syncThemeColor(): void {
    const view = this.document.defaultView;
    const meta = this.document.querySelector('meta[name="theme-color"]');
    if (!view || meta === null) {
      return;
    }
    const background = view
      .getComputedStyle(this.document.documentElement)
      .getPropertyValue('--bg')
      .trim();
    if (background !== '') {
      meta.setAttribute('content', background);
    }
  }

  private watchSystemPreference(): void {
    const view = this.document.defaultView;
    if (!view?.matchMedia) {
      return;
    }
    const query = view.matchMedia(LIGHT_SCHEME_QUERY);
    this.systemPrefersLight.set(query.matches);
    query.addEventListener('change', (event: MediaQueryListEvent) => {
      this.systemPrefersLight.set(event.matches);
    });
  }
}
