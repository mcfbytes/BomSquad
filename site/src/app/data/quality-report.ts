import { InjectionToken, Injectable, inject, resource } from '@angular/core';

import { DATABASE_FETCH } from './database';

/**
 * `dist/quality-report.json`, as `schemas/quality-report.schema.json` defines it.
 *
 * The flat scalar summary of one build (data-quality.md §8). Anything with more than one
 * row is a view in the shipped database, not a member here — which is why the dashboard
 * reads counts, shares and warning tallies from SQL and comes to this file only for the
 * two facts SQL cannot answer: how large the published artifact is, and which threshold
 * policy produced it.
 */
export interface QualityReport {
  readonly counts: {
    readonly chip: number;
    readonly implementation: number;
    readonly machine: number;
    readonly project: number;
    readonly system: number;
  };
  readonly dataset_version: string;
  readonly db_bytes: number;
  readonly devices: {
    readonly ignored: number;
    readonly mapped: number;
    readonly unmapped: number;
  };
  readonly instances: {
    readonly mapped: number;
    readonly mapped_instance_share: number;
    readonly total: number;
    readonly unmapped: number;
  };
  readonly mame_version: string;
  readonly schema_version: string;
  readonly threshold_version: string;
  /** Codes with zero rows are omitted; a missing key means zero. */
  readonly warnings_by_code: Readonly<Record<string, number>>;
}

export const QUALITY_REPORT_URL = new InjectionToken<string>('bomsquad.quality-report-url', {
  providedIn: 'root',
  factory: () => '/site-data/quality-report.json',
});

/**
 * Loads the published quality report, once.
 *
 * Deliberately a *second*, tiny fetch rather than something folded into the database:
 * `db_bytes` is a fact about the artifact that cannot be stored inside it without
 * changing it, and the report is the project's published quality contract (T6.4). It is
 * ~900 bytes and only the dashboard asks for it.
 *
 * A missing report is not an error state for the page. `dist/` is gitignored, so a fresh
 * clone has no report and no database; the dashboard says the report was not published
 * with this build and carries on rendering every figure it can get from SQL.
 */
@Injectable({ providedIn: 'root' })
export class QualityReportService {
  private readonly httpGet = inject(DATABASE_FETCH);
  private readonly url = inject(QUALITY_REPORT_URL);

  /**
   * Never rejects. Every failure — offline, 404, a navigation fallback answering with
   * `index.html`, a report from a future schema — resolves to `null`, and the dashboard
   * renders "not published with this build". An unreachable optional panel is not an
   * error state for a page whose other twenty figures come from SQL.
   */
  readonly report = resource<QualityReport | null, true>({
    params: () => true,
    defaultValue: null,
    loader: async () => {
      try {
        const response = await this.httpGet(this.url, { credentials: 'omit' });
        if (!response.ok) {
          return null;
        }
        const parsed: unknown = await response.json();
        return isQualityReport(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },
  });
}

/**
 * A shape check, not a validator.
 *
 * The pipeline validates the report against its JSON Schema before publishing it; this
 * only has to stop a 200-with-index.html from being rendered as though it carried
 * numbers. It checks the members the dashboard actually reads.
 */
function isQualityReport(value: unknown): value is QualityReport {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<keyof QualityReport, unknown>;
  return (
    typeof candidate.db_bytes === 'number' &&
    typeof candidate.dataset_version === 'string' &&
    typeof candidate.threshold_version === 'string' &&
    isObject(candidate.counts) &&
    isObject(candidate.warnings_by_code)
  );
}

function isObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null;
}
