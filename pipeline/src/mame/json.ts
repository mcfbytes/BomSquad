/**
 * The deterministic writer for `extract/*.raw.json`.
 *
 * ## Why not `JSON.stringify(whole, null, 2)`
 *
 * Two reasons, and the first is not style. Serialising 9,775 machines with their devices
 * in one call builds a single string of well over a hundred megabytes before a byte
 * reaches disk — which is both a large fraction of the RSS budget TASKS T2.2 sets and, for
 * a future MAME release, a hard failure against V8's maximum string length. Writing one
 * record at a time through a small buffer keeps the peak flat and independent of how many
 * machines MAME ships.
 *
 * The second is diffs. `extract/` is committed so pull requests can be read
 * (PLAN.md §2), and the unit a reviewer cares about is the machine: "these four boards
 * appeared, this one changed its driver". One compact record per line makes that a
 * four-line diff. Fully-indented output makes the same change several hundred lines and
 * roughly quadruples the file.
 *
 * This does **not** contradict data-model.md §4.3, which governs *row files* — flat
 * `{table: [rows]}` bundles under `data/` and `extract/`. These two files are neither:
 * they are the raw intermediate T6.1 reads to emit those row files, and they carry nested
 * arrays no row file may contain (which is also why `discoverRowFiles` skips `*.raw.json`).
 *
 * ## What determinism requires of a caller
 *
 * `JSON.stringify` writes object keys in insertion order and array elements in order, so
 * this module is deterministic exactly insofar as its input is ordered. Every array
 * reaching it must already be sorted by an explicit criterion, and no object here may be
 * built by iterating a `Map` or `Set` that was not sorted first. That is the whole of the
 * determinism contract; the golden fixtures in `test/mame-extract.test.ts` are what
 * enforce it, by presenting input whose document order is deliberately not its sorted
 * order.
 */
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** Flush threshold. Large enough that a 20 MB file is a few hundred writes. */
const BUFFER_BYTES = 1 << 20;

/** Scalars allowed in a file header. Deliberately not `unknown`: a header is a fact sheet. */
export type HeaderValue = string | number;

/**
 * Writes `{...header, [key]: [...records]}` with one compact record per line, UTF-8, LF
 * newlines, exactly one trailing newline. Returns the number of bytes written.
 *
 * `header` is written in its own key order, which the caller therefore chooses.
 */
export function writeRecordArrayFile(
  path: string,
  header: Readonly<Record<string, HeaderValue>>,
  key: string,
  records: readonly unknown[],
): number {
  mkdirSync(dirname(path), { recursive: true });
  const handle = openSync(path, 'w');
  let pending = '';
  let bytes = 0;
  const push = (text: string): void => {
    pending += text;
    if (pending.length >= BUFFER_BYTES) {
      bytes += writeSync(handle, pending);
      pending = '';
    }
  };
  try {
    push('{\n');
    for (const [name, value] of Object.entries(header)) {
      push(`  ${JSON.stringify(name)}: ${JSON.stringify(value)},\n`);
    }
    push(`  ${JSON.stringify(key)}: [\n`);
    records.forEach((record, index) => {
      push(`    ${JSON.stringify(record)}${index === records.length - 1 ? '' : ','}\n`);
    });
    push('  ]\n}\n');
    if (pending !== '') bytes += writeSync(handle, pending);
  } finally {
    closeSync(handle);
  }
  return bytes;
}
