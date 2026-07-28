/**
 * The formatting the nine views share.
 *
 * Every function has an explicit "we do not know" branch that returns an em dash
 * rather than `0`, `null` or a plausible-looking default. A data reference site
 * that prints `0 Hz` for an unrecorded clock is lying about its own coverage.
 */

/** What an absent value looks like everywhere on the site. */
export const UNKNOWN = '—';

const GROUPED = new Intl.NumberFormat('en-US');

export function formatCount(value: number | null | undefined): string {
  return value === null || value === undefined ? UNKNOWN : GROUPED.format(value);
}

/**
 * A clock as an engineer reads it: `3.579 MHz`, `4 MHz`, `100 kHz`.
 *
 * Trailing zeros are trimmed, so an exactly-4 MHz part does not render as
 * `4.000 MHz` and imply a precision the row file never claimed.
 */
export function formatHz(hz: number | null | undefined): string {
  if (hz === null || hz === undefined || hz <= 0) {
    return UNKNOWN;
  }
  if (hz >= 1_000_000) {
    return `${trim(hz / 1_000_000, 3)} MHz`;
  }
  if (hz >= 1000) {
    return `${trim(hz / 1000, 3)} kHz`;
  }
  return `${GROUPED.format(hz)} Hz`;
}

function trim(value: number, decimals: number): string {
  return String(Number(value.toFixed(decimals)));
}

/** A share in [0, 1] as a whole percentage. */
export function formatShare(share: number | null | undefined): string {
  return share === null || share === undefined ? UNKNOWN : `${Math.round(share * 100)}%`;
}

export function formatYear(year: number | null | undefined): string {
  return year === null || year === undefined ? UNKNOWN : String(year);
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) {
    return UNKNOWN;
  }
  const mib = 1024 * 1024;
  return bytes < mib ? `${Math.round(bytes / 1024)} kB` : `${(bytes / mib).toFixed(1)} MB`;
}

/** `n` with a unit that agrees with it: `1 chip`, `9 chips`, `— chips`. */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${GROUPED.format(count)} ${count === 1 ? singular : plural}`;
}

/**
 * A slug or lookup id as a label, for the few places a lookup table has no row to
 * join to. `sound-fm` → `Sound fm`. Only ever a fallback: where the schema has a
 * `label` column, the query joins it.
 */
export function humanize(id: string | null | undefined): string {
  if (id === null || id === undefined || id === '') {
    return UNKNOWN;
  }
  const spaced = id.replaceAll('-', ' ').replaceAll('_', ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Where a MAME driver's source lives, for the pinned release the dataset was built from. */
export function mameDriverUrl(sourcefile: string, mameVersion: string | null): string {
  const tag = mameVersion === null ? 'master' : `mame${mameVersion.replace('.', '')}`;
  return `https://github.com/mamedev/mame/blob/${tag}/src/mame/${sourcefile}`;
}
