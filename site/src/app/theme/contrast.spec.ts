import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * WCAG AA contrast, verified numerically against the shipped palette.
 *
 * T7.12's acceptance bar is explicit that a pixel font at small sizes is a
 * contrast trap and that ratios must be computed rather than eyeballed. This
 * spec parses `src/styles/_palette.scss` — the actual file the build compiles,
 * not a copy — so a token can never drift away from a ratio that was checked
 * once and then forgotten.
 *
 * It also re-checks the pairs that sit *under* the CRT texture: the scanline and
 * vignette layers paint behind the text (z-index 0 vs 1 in _arcade.scss), so
 * they never dim a glyph, but they do shift the effective background, and in the
 * light theme that shift moves in the wrong direction.
 *
 * Scope, stated honestly: the pair lists below are hand-maintained, so this is
 * "every pair we decided matters", not "every pair the browser can produce".
 * What keeps that from rotting is the completeness test at the bottom — every
 * token in the palette must be classified as a foreground, a surface, or an
 * explicit exemption, so adding a token fails the suite until someone decides
 * which it is.
 */

const PALETTE_PATH = resolve(process.cwd(), 'src/styles/_palette.scss');

/** WCAG 2.2 1.4.3 — normal-size text. */
const AA_TEXT = 4.5;
/** WCAG 2.2 1.4.11 — non-text UI boundaries. */
const AA_UI = 3;

type Rgb = readonly [number, number, number];

function parseHex(value: string): Rgb {
  const digits = value.replace('#', '');
  const channel = (index: number): number => parseInt(digits.slice(index, index + 2), 16);
  return [channel(0), channel(2), channel(4)];
}

function parseRgba(value: string): { readonly rgb: Rgb; readonly alpha: number } {
  const match = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/.exec(value);
  if (match === null) {
    throw new Error(`Not an rgba() colour: ${value}`);
  }
  const [, r = '0', g = '0', b = '0', a = '0'] = match;
  return { rgb: [Number(r), Number(g), Number(b)], alpha: Number(a) };
}

/** Source-over composite of a translucent layer onto an opaque base. */
function composite(layer: Rgb, alpha: number, base: Rgb): Rgb {
  const mix = (index: 0 | 1 | 2): number => layer[index] * alpha + base[index] * (1 - alpha);
  return [mix(0), mix(1), mix(2)];
}

function relativeLuminance(rgb: Rgb): number {
  const linear = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  });
  const [r = 0, g = 0, b = 0] = linear;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: Rgb, b: Rgb): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
}

/**
 * Pull `--token: value;` declarations out of one `@mixin <name> { … }` block.
 * The palette file is deliberately plain CSS custom properties so this stays a
 * three-line parser rather than a Sass evaluation.
 */
function readPalette(source: string, mixin: string): ReadonlyMap<string, string> {
  const block = new RegExp(`@mixin\\s+${mixin}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(source);
  if (block === null) {
    throw new Error(`No @mixin ${mixin} in ${PALETTE_PATH}`);
  }
  const tokens = new Map<string, string>();
  for (const match of (block[1] ?? '').matchAll(/^\s*--([\w-]+):\s*([^;]+);/gm)) {
    tokens.set(match[1] ?? '', (match[2] ?? '').trim());
  }
  return tokens;
}

const source = readFileSync(PALETTE_PATH, 'utf8');
const palettes = {
  dark: readPalette(source, 'dark'),
  light: readPalette(source, 'light'),
} as const;

/** The seven tokens the original scaffold shipped. Renaming any is a breaking change. */
const ORIGINAL_CONTRACT = ['bg', 'surface', 'border', 'fg', 'muted', 'accent', 'focus'] as const;

const TEXT_PAIRS: readonly (readonly [string, string])[] = [
  ['fg', 'bg'],
  ['fg', 'surface'],
  ['fg', 'surface-2'],
  ['muted', 'bg'],
  ['muted', 'surface'],
  ['muted', 'surface-2'],
  ['accent', 'bg'],
  ['accent', 'surface'],
  ['accent', 'surface-2'],
  ['accent-2', 'bg'],
  ['accent-2', 'surface'],
  ['accent-3', 'bg'],
  ['accent-3', 'surface'],
  ['link', 'bg'],
  ['link', 'surface'],
  ['link', 'surface-2'],
  ['focus', 'bg'],
  ['focus', 'surface'],
  ['focus', 'surface-2'],
  ['ok', 'bg'],
  ['ok', 'surface'],
  ['warn', 'bg'],
  ['warn', 'surface'],
  ['bad', 'bg'],
  ['bad', 'surface'],
  // Coverage badges fill with a tone and set text to `--accent-ink`.
  ['accent-ink', 'ok'],
  ['accent-ink', 'warn'],
  ['accent-ink', 'bad'],
  ['accent-ink', 'muted'],
  ['accent-ink', 'accent'],
];

/** Chunky borders are real component boundaries, so they owe 3:1, not nothing. */
const UI_PAIRS: readonly (readonly [string, string])[] = [
  ['border', 'bg'],
  ['border', 'surface'],
  ['border', 'surface-2'],
  ['border-strong', 'bg'],
  ['border-strong', 'surface'],
  ['border-strong', 'surface-2'],
];

/** Text that renders on top of the CRT-textured masthead and hero. */
const CRT_TEXT_TOKENS = ['fg', 'muted', 'accent'] as const;

function token(theme: keyof typeof palettes, name: string): string {
  const value = palettes[theme].get(name);
  if (value === undefined) {
    throw new Error(`--${name} is not defined in the ${theme} palette`);
  }
  return value;
}

describe.each(['dark', 'light'] as const)('%s theme palette', (theme) => {
  it('keeps every token of the original scaffold contract', () => {
    for (const name of ORIGINAL_CONTRACT) {
      expect(palettes[theme].has(name)).toBe(true);
    }
  });

  it.each(TEXT_PAIRS)('renders --%s on --%s at WCAG AA for text', (fg, bg) => {
    const ratio = contrast(parseHex(token(theme, fg)), parseHex(token(theme, bg)));
    expect(ratio).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it.each(UI_PAIRS)('draws --%s against --%s at WCAG AA for UI boundaries', (line, bg) => {
    const ratio = contrast(parseHex(token(theme, line)), parseHex(token(theme, bg)));
    expect(ratio).toBeGreaterThanOrEqual(AA_UI);
  });

  // The scanline and the vignette can overlap, so the worst case is both layers
  // composited over --surface at once.
  it.each(CRT_TEXT_TOKENS)('keeps --%s legible under the CRT texture', (fg) => {
    const scanline = parseRgba(token(theme, 'crt-scanline'));
    const vignette = parseRgba(token(theme, 'crt-vignette'));
    const surface = parseHex(token(theme, 'surface'));

    const withScanline = composite(scanline.rgb, scanline.alpha, surface);
    const worstCase = composite(vignette.rgb, vignette.alpha, withScanline);

    const ratio = contrast(parseHex(token(theme, fg)), worstCase);
    expect(ratio).toBeGreaterThanOrEqual(AA_TEXT);
  });
});

describe('theme separation', () => {
  it('makes light a genuine light theme, not an inverted dark one', () => {
    const darkBg = relativeLuminance(parseHex(token('dark', 'bg')));
    const lightBg = relativeLuminance(parseHex(token('light', 'bg')));

    expect(darkBg).toBeLessThan(0.05);
    expect(lightBg).toBeGreaterThan(0.7);
    // An inversion would reuse the same hues; these palettes do not.
    expect(token('light', 'accent')).not.toBe(token('dark', 'accent'));
  });

  it('gives every dark token a light counterpart', () => {
    expect([...palettes.light.keys()].sort()).toEqual([...palettes.dark.keys()].sort());
  });
});

describe('the pair lists cover the whole palette', () => {
  /** Tokens that are never a foreground or a background of anything. */
  const EXEMPT = new Set([
    'surface-2', // a background, covered as the `bg` side of the pairs above
    'shadow', // a hard offset edge, not a boundary anything has to be read against
    'crt-scanline', // checked by compositing, not as a colour in its own right
    'crt-vignette',
  ]);

  it.each(['dark', 'light'] as const)('classifies every %s token', (theme) => {
    const checked = new Set<string>();
    for (const [fg, bg] of [...TEXT_PAIRS, ...UI_PAIRS]) {
      checked.add(fg);
      checked.add(bg);
    }
    for (const name of CRT_TEXT_TOKENS) {
      checked.add(name);
    }

    const unclassified = [...palettes[theme].keys()].filter(
      (name) => !checked.has(name) && !EXEMPT.has(name),
    );

    expect(unclassified).toEqual([]);
  });
});
