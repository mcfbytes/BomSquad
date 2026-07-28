import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The T7.12 constraints that are properties of the *source tree* rather than of
 * a rendered component: self-hosting, the bundle budget, where decoration is
 * allowed to appear, and the two media queries that switch it all off.
 *
 * These are the guards that stop the theme drifting back into the data zone
 * once T7.4–T7.9 start adding real views.
 */

const SITE_ROOT = process.cwd();
const FONT_PATH = resolve(SITE_ROOT, 'public/fonts/bom-squad-pixel.woff2');

function read(relativePath: string): string {
  return readFileSync(resolve(SITE_ROOT, relativePath), 'utf8');
}

function sourceFiles(directory: string, extensions: readonly string[]): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(resolve(SITE_ROOT, directory))) {
    const path = join(directory, entry);
    if (statSync(resolve(SITE_ROOT, path)).isDirectory()) {
      found.push(...sourceFiles(path, extensions));
    } else if (extensions.some((extension) => entry.endsWith(extension))) {
      found.push(path);
    }
  }
  return found;
}

describe('pixel display face', () => {
  const typography = read('src/styles/_typography.scss');

  it("is self-hosted — the CSP is `font-src 'self' data:`", () => {
    expect(typography).toContain("url('/fonts/bom-squad-pixel.woff2') format('woff2')");
    expect(typography).not.toMatch(/https?:\/\//);
  });

  it('never reaches for a font CDN anywhere in the app', () => {
    const sources = ['src/index.html', ...sourceFiles('src', ['.ts', '.html', '.scss'])];
    for (const path of sources) {
      expect(read(path)).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    }
  });

  it('swaps rather than blocking first paint', () => {
    expect(typography).toContain('font-display: swap');
  });

  it('declares a unicode-range, so an unsubsetted glyph falls back instead of tofu', () => {
    expect(typography).toContain('unicode-range:');
  });

  it('stays far inside the initial bundle budget', () => {
    // angular.json budgets the initial bundle at 500 kB warn / 1 MB error. The
    // subset is ~2.3 kB, which is noise; this guard exists to catch someone
    // dropping the full 118 kB TTF in by accident.
    expect(statSync(FONT_PATH).size).toBeLessThan(8 * 1024);
  });

  it('offers the bitmap face only at whole multiples of its 8-unit grid', () => {
    // One font "pixel" is font-size / 8, so only multiples of 8px land on a
    // whole device pixel at DPR 1. A 12px step used to exist and carried the
    // badges, buttons and eyebrows; it dropped strokes out of `W`, `M` and `%`
    // on any non-retina display. Chrome below 16px uses `m.chrome-label`.
    const steps = [...typography.matchAll(/--display-\w+:\s*([\d.]+)rem/g)].map(
      (match) => Number(match[1]) * 16,
    );

    expect(steps).toEqual([16, 24, 32]);
    for (const step of steps) {
      expect(step % 8).toBe(0);
    }
  });

  it('leaves no sub-16px display step for anything to reach for', () => {
    const offenders = sourceFiles('src', ['.ts', '.scss'])
      .filter((path) => !path.endsWith('.spec.ts'))
      .filter((path) => read(path).includes('--display-xs'));

    expect(offenders).toEqual([]);
  });

  it('routes the three highest-traffic chrome elements through the sans label scale', () => {
    // Coverage badges, buttons and eyebrows. These are exactly the elements the
    // deleted 12px step used to carry.
    expect(read('src/app/shared/coverage-badge.ts')).toMatch(
      /data-size='sm'[\s\S]*?font-family: var\(--font-body\)/,
    );
    expect(read('src/styles/_arcade.scss')).toMatch(
      /\.pixel-button \{[\s\S]*?font-size: var\(--label-md\)/,
    );
    expect(read('src/styles/_typography.scss')).toMatch(
      /\.eyebrow \{[\s\S]*?font-size: var\(--label-md\)/,
    );
  });

  it('ships the OFL text alongside the font', () => {
    expect(read('public/fonts/OFL.txt')).toContain('SIL OPEN FONT LICENSE Version 1.1');
  });
});

describe('production build settings', () => {
  it('keeps critical-CSS inlining off', () => {
    // Angular's inliner emits `<link media="print" onload="this.media='all'">`,
    // and the production CSP is `script-src 'self'` with no 'unsafe-inline': the
    // handler never fires, the stylesheet is never promoted, and the site paints
    // with only the above-the-fold slice of the theme. `ng update` rewrites
    // angular.json and can drop the comment explaining that, so assert it here
    // too — the rationale lives in site/README.md under "Build notes".
    const config: unknown = JSON.parse(read('angular.json').replace(/^\s*\/\/.*$/gm, ''));
    const production = (
      config as {
        projects: Record<
          string,
          { architect: { build: { configurations: { production: Record<string, unknown> } } } }
        >;
      }
    ).projects['bom-squad-site']?.architect.build.configurations.production;

    expect(production?.['optimization']).toMatchObject({
      styles: { inlineCritical: false },
    });
  });
});

describe('decoration stays on chrome', () => {
  it('applies the CRT texture to the masthead and the home hero, and nothing else', () => {
    const users = sourceFiles('src', ['.ts', '.html'])
      .filter((path) => !path.endsWith('.spec.ts'))
      .filter((path) => /class="[^"]*\bcrt\b/.test(read(path)));

    expect([...users].sort()).toEqual(['src/app/app.html', 'src/app/home/home.ts']);
  });

  it('keeps the data zone free of the pixel face', () => {
    const arcade = read('src/styles/_arcade.scss');
    const dataZone = arcade.slice(arcade.indexOf('table {'));

    expect(dataZone).toContain('font-family: var(--font-body)');
    expect(dataZone).not.toContain('--font-display');
  });

  it('never applies the display face to a bare element selector', () => {
    // Slicing the file from `table {` onward — which this guard used to do — is
    // not a definition of "the data zone": the `button` block sits above that
    // line, so styling the bare `button` element sailed straight past it.
    // Rule: the arcade layer may only decorate classes it is asked for.
    const decorated = [
      ...read('src/styles/_arcade.scss').matchAll(/^([a-z][\w\s,:>+~()-]*)\s*\{/gm),
    ].map((match) => match[1]?.trim() ?? '');

    // `table`, `th`, `td`, `caption`, `tbody tr:nth-child(even)` are the data
    // zone's deliberately plain element defaults and carry no decoration.
    expect([...decorated].sort()).toEqual([
      'caption',
      'table',
      'tbody tr:nth-child(even)',
      'td',
      'th',
    ]);
  });
});

describe('accessibility escape hatches', () => {
  const a11y = read('src/styles/_a11y.scss');

  it('drops the CRT texture entirely under prefers-contrast: more', () => {
    expect(a11y).toMatch(
      /@media \(prefers-contrast: more\)[\s\S]*\.crt::before\s*\{\s*display: none;/,
    );
  });

  it('kills animation and transitions under prefers-reduced-motion', () => {
    expect(a11y).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(a11y).toContain('animation-duration: 1ms !important');
    expect(a11y).toContain('transition-duration: 1ms !important');
  });

  it('declares the scanline animation only for users who have not opted out', () => {
    expect(read('src/styles/_arcade.scss')).toMatch(
      /@media \(prefers-reduced-motion: no-preference\)[\s\S]*animation: crt-drift/,
    );
  });

  it('keeps a 3px focus ring the theme cannot quietly weaken', () => {
    expect(a11y).toMatch(/:focus-visible\s*\{[\s\S]*outline: 3px solid var\(--focus\);/);
  });

  it('loads the overrides last, so they win on source order without !important', () => {
    const globals = read('src/styles.scss');
    const order = ['themes', 'typography', 'base', 'arcade', 'a11y'].map((name) =>
      globals.indexOf(`@use './styles/${name}'`),
    );

    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.at(-1)).toBe(globals.indexOf("@use './styles/a11y'"));
  });
});
