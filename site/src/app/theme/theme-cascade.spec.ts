import { resolve } from 'node:path';

import * as sass from 'sass';

/**
 * Cascade assertions against the REAL compiled stylesheet.
 *
 * `_a11y.scss` shipped a bug that a grep-based guard could never have caught:
 * its `prefers-contrast: more` token overrides were declared on a bare `:root`
 * (0,1,0) while `_themes.scss` declares the same tokens on
 * `:root[data-theme='…']` and `:root:not([data-theme])` (0,2,0). Specificity
 * beats source order, so the overrides were dead for every real visitor even
 * though the rule text was present and correct. Grepping for the text passed;
 * the feature did not work.
 *
 * So this file compiles `src/styles.scss` with the same Sass the build uses and
 * resolves the winning declaration by (specificity, source order), which is what
 * the browser does.
 */

const STYLES = resolve(process.cwd(), 'src/styles.scss');

interface Rule {
  readonly media: string | null;
  readonly selector: string;
  readonly declarations: ReadonlyMap<string, string>;
  readonly order: number;
}

function matchingBrace(css: string, open: number): number {
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error('Unbalanced braces in compiled CSS');
}

function parseDeclarations(body: string): ReadonlyMap<string, string> {
  const declarations = new Map<string, string>();
  for (const statement of body.split(';')) {
    const separator = statement.indexOf(':');
    if (separator === -1) continue;
    const property = statement.slice(0, separator).trim();
    if (!property.startsWith('--')) continue;
    declarations.set(property, statement.slice(separator + 1).trim());
  }
  return declarations;
}

function parseRules(css: string, media: string | null, out: Rule[]): void {
  let index = 0;
  while (index < css.length) {
    const open = css.indexOf('{', index);
    if (open === -1) return;
    // Statement-level at-rules (`@charset "UTF-8";`) sit in front of the next
    // prelude, so cut at the last `;` — otherwise the first real rule in the
    // file looks like an at-rule and gets skipped.
    const raw = css.slice(index, open);
    const prelude = raw.slice(raw.lastIndexOf(';') + 1).trim();
    const close = matchingBrace(css, open);
    const body = css.slice(open + 1, close);

    if (prelude.startsWith('@media')) {
      parseRules(body, prelude.slice('@media'.length).trim(), out);
    } else if (!prelude.startsWith('@')) {
      out.push({
        media,
        selector: prelude,
        declarations: parseDeclarations(body),
        order: out.length,
      });
    }
    index = close + 1;
  }
}

/** Specificity of the `:root`-shaped selectors this stylesheet uses. */
function specificity(selector: string): number {
  const attributes = (selector.match(/\[[^\]]*\]/g) ?? []).length;
  const pseudoClasses = (selector.match(/:(?!:)[a-z-]+/g) ?? []).filter(
    (pseudo) => pseudo !== ':not',
  ).length;
  return attributes + pseudoClasses;
}

const ROOT_SELECTOR = /^:root(?:\[data-theme=["']?([a-z]+)["']?\]|:not\(\[data-theme\]\))?$/;

/**
 * Does this single selector match `<html>` with the given `data-theme`?
 * Returns `null` for any shape this matcher does not understand, so an
 * unrecognised selector fails the suite instead of silently not matching.
 */
function matchesRoot(selector: string, dataTheme: string | null): boolean | null {
  const parsed = ROOT_SELECTOR.exec(selector.trim());
  if (parsed === null) return null;
  if (selector.includes(':not(')) return dataTheme === null;
  if (parsed[1] !== undefined) return dataTheme === parsed[1];
  return true;
}

const normalise = (query: string): string => query.replace(/\s+/g, '');

// Comments are stripped first: they survive compilation, and a `{` or `}` inside
// one would derail the brace scanner.
const compiled = sass.compile(STYLES).css;
const rules: Rule[] = [];
parseRules(compiled.replace(/\/\*[\s\S]*?\*\//g, ''), null, rules);

/** Every `:root` rule that declares a custom property, in source order. */
const rootRules = rules.filter(
  (rule) => rule.selector.includes(':root') && rule.declarations.size > 0,
);

function winner(
  property: string,
  dataTheme: string | null,
  activeMedia: readonly string[],
): string {
  const active = activeMedia.map(normalise);
  let best: { rule: Rule; specificity: number } | null = null;

  for (const rule of rootRules) {
    if (rule.media !== null && !active.includes(normalise(rule.media))) continue;
    if (!rule.declarations.has(property)) continue;

    for (const selector of rule.selector.split(',')) {
      const matched = matchesRoot(selector, dataTheme);
      if (matched === null) {
        throw new Error(
          `Unrecognised :root selector shape — teach the matcher: "${selector.trim()}"`,
        );
      }
      if (!matched) continue;
      const score = specificity(selector);
      if (
        best === null ||
        score > best.specificity ||
        (score === best.specificity && rule.order > best.rule.order)
      ) {
        best = { rule, specificity: score };
      }
    }
  }

  const value = best?.rule.declarations.get(property);
  if (value === undefined) {
    throw new Error(`Nothing declares ${property} for data-theme=${String(dataTheme)}`);
  }
  return value;
}

const CONTRAST = '(prefers-contrast: more)';
/** `theme-init.js` always stamps the attribute; `null` is the JavaScript-off path. */
const CONTEXTS = ['dark', 'light', null] as const;

describe('the cascade parser sees what it thinks it sees', () => {
  // A hand-rolled CSS parser that silently skips a rule turns every assertion
  // below into a no-op, so prove it picked up both unconditional palette blocks
  // before trusting anything it says.
  it('finds both palettes outside any media query', () => {
    const unconditional = rootRules
      .filter((rule) => rule.media === null && rule.declarations.has('--bg'))
      .map((rule) => rule.selector.replace(/\s+/g, ' '));

    expect(unconditional).toEqual([':root, :root[data-theme=dark]', ':root[data-theme=light]']);
  });
});

describe('prefers-contrast: more actually overrides the theme', () => {
  it.each(CONTEXTS)('swaps --border to the strong variant (data-theme=%s)', (dataTheme) => {
    expect(winner('--border', dataTheme, [CONTRAST])).toBe('var(--border-strong)');
  });

  it.each(CONTEXTS)('promotes --muted to full foreground (data-theme=%s)', (dataTheme) => {
    expect(winner('--muted', dataTheme, [CONTRAST])).toBe('var(--fg)');
  });

  it.each(CONTEXTS)('clears the CRT texture colours (data-theme=%s)', (dataTheme) => {
    expect(winner('--crt-scanline', dataTheme, [CONTRAST])).toBe('transparent');
    expect(winner('--crt-vignette', dataTheme, [CONTRAST])).toBe('transparent');
  });
});

describe('without prefers-contrast, the palette wins', () => {
  it('resolves the dark palette for data-theme=dark', () => {
    expect(winner('--border', 'dark', [])).toBe('#65768e');
    expect(winner('--bg', 'dark', [])).toBe('#0a0c10');
  });

  it('resolves the light palette for data-theme=light', () => {
    expect(winner('--border', 'light', [])).toBe('#3b4250');
    expect(winner('--bg', 'light', [])).toBe('#f7f4ec');
  });

  it('falls back to dark when no data-theme is stamped', () => {
    expect(winner('--bg', null, [])).toBe('#0a0c10');
  });

  it('honours prefers-color-scheme: light only while data-theme is absent', () => {
    const light = '(prefers-color-scheme: light)';
    expect(winner('--bg', null, [light])).toBe('#f7f4ec');
    expect(winner('--bg', 'dark', [light])).toBe('#0a0c10');
  });
});

describe('the arcade button is opt-in', () => {
  // The bare `button` element used to carry the pixel face, uppercase, offset
  // shadow and press transform, so a sortable column header (T7.5) or a score
  // breakdown toggle (T7.7) would have inherited the arcade cap — decoration
  // landing on data, which is the one thing T7.12 forbids.
  it('never styles a bare `button` type selector', () => {
    const offenders = rules
      .map((rule) => rule.selector)
      .filter((selector) => /(^|[\s,>+~])button\b/.test(selector));

    expect(offenders).toEqual([]);
  });

  it('still ships the .pixel-button class the chrome opts into', () => {
    expect(compiled).toContain('.pixel-button');
  });
});
