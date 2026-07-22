/**
 * Rendering of validation results.
 *
 * The acceptance criterion for this task is actionability: a diagnostic that says only
 * "constraint failed" is a failed diagnostic. Every line therefore names the file, the
 * offending row's primary key, the offending column, the rule that fired, and a concrete
 * next action. The renderer enforces that shape; the producers in `rules.ts` and
 * `index.ts` fill it in.
 */
import { compareBytes } from '../db/rowfiles.js';
import type { Diagnostic } from './rules.js';

export interface ValidationResult {
  /** Row files read. */
  readonly fileCount: number;
  /** Rows parsed across every file. */
  readonly rowCount: number;
  /** Every finding, unsorted. */
  readonly diagnostics: readonly Diagnostic[];
}

export interface ReportOptions {
  /** Treat WARN as failure. */
  readonly strict: boolean;
}

const SEVERITY_RANK: Readonly<Record<string, number>> = { ERROR: 0, WARN: 1 };

/** Deterministic order: errors first, then file, table, key, rule, column. */
export function sortDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort((a, b) => {
    const bySeverity = (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
    if (bySeverity !== 0) return bySeverity;
    for (const field of ['file', 'table', 'key', 'rule', 'column'] as const) {
      const order = compareBytes(a[field], b[field]);
      if (order !== 0) return order;
    }
    return compareBytes(a.message, b.message);
  });
}

export function countBySeverity(diagnostics: readonly Diagnostic[]): {
  errors: number;
  warnings: number;
} {
  let errors = 0;
  let warnings = 0;
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === 'ERROR') errors += 1;
    else warnings += 1;
  }
  return { errors, warnings };
}

/** `chip[ym2151].manufacturer_id` — the row and column a diagnostic accuses. */
export function subjectOf(diagnostic: Diagnostic): string {
  const { table, key, column } = diagnostic;
  if (table === '') {
    if (column !== '') return column;
    return diagnostic.file === '(database)' ? '(dataset)' : '(file)';
  }
  const row = key === '' ? table : `${table}[${key}]`;
  return column === '' ? row : `${row}.${column}`;
}

/** One diagnostic as two lines: the accusation, then the fix. */
export function formatDiagnostic(diagnostic: Diagnostic): string {
  const head = `${diagnostic.severity} ${diagnostic.file}: ${subjectOf(diagnostic)} [${diagnostic.rule}] ${diagnostic.message}`;
  return `${head}\n      fix: ${diagnostic.fix}`;
}

/** The full human-readable report, ending in a newline. Empty dataset renders cleanly. */
export function formatReport(result: ValidationResult, options: ReportOptions): string {
  const sorted = sortDiagnostics(result.diagnostics);
  const { errors, warnings } = countBySeverity(sorted);
  const lines = sorted.map(formatDiagnostic);
  if (lines.length > 0) lines.push('');
  lines.push(
    `${result.fileCount} file${result.fileCount === 1 ? '' : 's'}, ` +
      `${result.rowCount} row${result.rowCount === 1 ? '' : 's'}, ` +
      `${errors} error${errors === 1 ? '' : 's'}, ` +
      `${warnings} warning${warnings === 1 ? '' : 's'}` +
      (options.strict && warnings > 0 ? ' (--strict: warnings fail the build)' : ''),
  );
  return `${lines.join('\n')}\n`;
}

/** Machine-readable form. Keys are bytewise ascending so the output is diffable. */
export function formatJson(result: ValidationResult, options: ReportOptions): string {
  const sorted = sortDiagnostics(result.diagnostics);
  const { errors, warnings } = countBySeverity(sorted);
  return `${JSON.stringify(
    {
      diagnostics: sorted.map((diagnostic) => ({
        column: diagnostic.column,
        file: diagnostic.file,
        fix: diagnostic.fix,
        key: diagnostic.key,
        message: diagnostic.message,
        rule: diagnostic.rule,
        severity: diagnostic.severity,
        table: diagnostic.table,
      })),
      errors,
      files: result.fileCount,
      ok: !failed(result, options),
      rows: result.rowCount,
      strict: options.strict,
      warnings,
    },
    null,
    2,
  )}\n`;
}

/** Exit-code policy: any ERROR fails; a WARN fails only under `--strict`. */
export function failed(result: ValidationResult, options: ReportOptions): boolean {
  const { errors, warnings } = countBySeverity(result.diagnostics);
  return errors > 0 || (options.strict && warnings > 0);
}
