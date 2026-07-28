import { Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import { DataStatus } from '../data/data-status';
import { DatabaseService } from '../data/database';
import { isPending, query, queryAll } from '../data/query';
import { CoverageBadge } from '../shared/coverage-badge';
import { UNKNOWN, formatCount, pluralize } from '../shared/format';
import {
  controlValue,
  matchesText,
  param,
  paramValue,
  queryParamWriter,
} from '../shared/url-filters';

interface SystemListRow {
  readonly system_id: string;
  readonly name: string;
  readonly kind_id: string;
  readonly kind_label: string;
  readonly manufacturer_id: string | null;
  readonly manufacturer_name: string | null;
  readonly year_introduced: number | null;
  readonly description: string | null;
  readonly chips_total: number;
  readonly chips_satisfied: number;
  readonly unmapped_device_count: number;
  readonly confidence: string | null;
  readonly machine_count: number;
  readonly core_count: number;
}

/**
 * Family-level coverage comes straight out of `v_system_coverage_by_kind` — the one SQL
 * definition of the project's headline metric — rather than being recomputed here.
 * `confidence` and `unmapped_device_count` ride along with it and are shown, not dropped.
 */
const SYSTEM_LIST_SQL = `
WITH members AS (
  SELECT system_id, COUNT(*) AS machine_count
  FROM v_machine_system WHERE system_id IS NOT NULL GROUP BY system_id
),
cores AS (
  SELECT system_id, COUNT(DISTINCT implementation_id) AS core_count
  FROM implementation_system GROUP BY system_id
)
SELECT s.system_id, s.name, s.kind_id, sk.label AS kind_label,
       s.manufacturer_id, mf.name AS manufacturer_name, s.year_introduced, s.description,
       COALESCE(c.chips_total, 0)          AS chips_total,
       COALESCE(c.chips_satisfied, 0)      AS chips_satisfied,
       COALESCE(c.unmapped_device_count, 0) AS unmapped_device_count,
       c.confidence,
       COALESCE(mb.machine_count, 0)       AS machine_count,
       COALESCE(cr.core_count, 0)          AS core_count
FROM system s
JOIN system_kind sk       ON sk.kind_id = s.kind_id
LEFT JOIN manufacturer mf ON mf.manufacturer_id = s.manufacturer_id
LEFT JOIN v_system_coverage_by_kind c
       ON c.system_id = s.system_id AND c.kind_id = 'fpga_hdl'
LEFT JOIN members mb      ON mb.system_id = s.system_id
LEFT JOIN cores cr        ON cr.system_id = s.system_id
ORDER BY s.name, s.system_id`;

/**
 * Platform-family index (PLAN §5 view 6's parent, TASKS T7.6).
 *
 * The system16.com dimension: one shared chipset carrying a whole catalogue of machines.
 * Every card shows the family's own coverage *and* the two qualifiers that make it
 * readable — how many of its MAME devices are still uncatalogued, and what confidence
 * the coverage view assigns as a result.
 */
@Component({
  selector: 'app-system-browser',
  imports: [RouterLink, CoverageBadge, DataStatus],
  template: `
    <header class="view__head">
      <p class="eyebrow">Platform families</p>
      <h1>Systems</h1>
      <p class="view__lede">
        The shared-chipset dimension: Sega System 16B, Capcom CPS-1, Neo Geo MVS. One family page
        covers a whole catalogue of machines, and family-level coverage is what the Prospector
        ranks.
      </p>
    </header>

    <form class="filters" (submit)="$event.preventDefault()">
      <div class="filters__field filters__field--wide">
        <label class="filters__label" for="system-q">Name or id contains</label>
        <input
          id="system-q"
          class="filters__control"
          type="search"
          autocomplete="off"
          [value]="q()"
          (input)="setParam('q', $event)"
        />
      </div>

      <div class="filters__field">
        <label class="filters__label" for="system-kind">Kind</label>
        <select
          id="system-kind"
          class="filters__control"
          [value]="kind()"
          (change)="setParam('kind', $event)"
        >
          <option value="">All kinds</option>
          @for (row of kinds.value(); track row.kind_id) {
            <option [value]="row.kind_id">{{ row.label }}</option>
          }
        </select>
      </div>

      <div class="filters__field">
        <label class="filters__label" for="system-manufacturer">Manufacturer</label>
        <select
          id="system-manufacturer"
          class="filters__control"
          [value]="manufacturer()"
          (change)="setParam('manufacturer', $event)"
        >
          <option value="">All manufacturers</option>
          @for (row of manufacturersInPlay(); track row.id) {
            <option [value]="row.id">{{ row.name }}</option>
          }
        </select>
      </div>

      <div class="filters__field filters__field--narrow">
        <label class="filters__label" for="system-core">Has a core</label>
        <select
          id="system-core"
          class="filters__control"
          [value]="core()"
          (change)="setParam('core', $event)"
        >
          <option value="">Either</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      </div>

      <div class="filters__actions">
        <button type="button" class="pixel-button" (click)="reset()">Reset</button>
      </div>
    </form>

    <app-data-status
      [loading]="pending()"
      [error]="systems.error()"
      loadingLabel="Loading platform families…"
      (retry)="systems.reload()"
    />

    @if (!pending() && systems.error() === undefined) {
      <p class="result-count">
        <strong>{{ formatCount(rows().length) }}</strong> of
        {{ formatCount(systems.value().length) }} families. {{ formatCount(withCore()) }} already
        have at least one FPGA core.
      </p>

      @if (rows().length === 0) {
        <p class="empty">No platform family matches these filters.</p>
      } @else {
        <ul class="card-grid plain-list">
          @for (system of rows(); track system.system_id) {
            <li class="panel panel--flat family">
              <h2 class="family__name">
                <a [routerLink]="['/system', system.system_id]">{{ system.name }}</a>
              </h2>
              <p class="family__sub">
                {{ system.manufacturer_name ?? unknown }} · {{ system.kind_label }} ·
                {{ system.year_introduced ?? unknown }}
              </p>
              @if (system.description; as description) {
                <p class="family__blurb">{{ description }}</p>
              }
              <div class="tag-row">
                <app-coverage-badge
                  size="sm"
                  [covered]="system.chips_satisfied"
                  [total]="system.chips_total"
                />
                @if (system.confidence; as confidence) {
                  <span
                    class="tag"
                    [class.tag--ok]="confidence === 'high'"
                    [class.tag--warn]="confidence === 'medium'"
                    [class.tag--bad]="confidence === 'low'"
                    >{{ confidence }} confidence</span
                  >
                }
                @if (system.unmapped_device_count > 0) {
                  <span class="tag tag--muted">{{ system.unmapped_device_count }} unmapped</span>
                }
                @if (system.core_count > 0) {
                  <span class="tag tag--ok">{{ pluralize(system.core_count, 'core') }}</span>
                } @else {
                  <span class="tag">no core yet</span>
                }
              </div>
              <p class="family__machines">
                {{ pluralize(system.machine_count, 'machine') }}
              </p>
            </li>
          }
        </ul>
      }
    }
  `,
  styles: `
    :host {
      display: block;
    }

    .family {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    .family__name {
      margin: 0;
      font-size: var(--display-sm);
    }

    .family__sub,
    .family__machines {
      margin: 0;
      color: var(--muted);
      font-size: 0.875rem;
    }

    .family__blurb {
      margin: 0;
      font-size: 0.9375rem;
    }

    .family__machines {
      margin-top: auto;
    }
  `,
})
export class SystemBrowser {
  private readonly database = inject(DatabaseService);
  private readonly write = queryParamWriter();

  readonly q = input('', { transform: param });
  readonly kind = input('', { transform: param });
  readonly manufacturer = input('', { transform: param });
  readonly core = input('', { transform: param });

  protected readonly unknown = UNKNOWN;
  protected readonly formatCount = formatCount;
  protected readonly pluralize = pluralize;

  protected readonly systems = query<SystemListRow>(() => ({ sql: SYSTEM_LIST_SQL }));
  protected readonly kinds = queryAll('system_kind', { orderBy: 'label' });

  protected readonly pending = computed(
    () => isPending(this.systems)() || this.database.isLoading(),
  );

  protected readonly manufacturersInPlay = computed(() => {
    const names = new Map<string, string>();
    for (const system of this.systems.value()) {
      if (system.manufacturer_id !== null) {
        names.set(system.manufacturer_id, system.manufacturer_name ?? system.manufacturer_id);
      }
    }
    return [...names]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  protected readonly rows = computed(() => {
    const term = this.q();
    const kind = this.kind().trim();
    const maker = this.manufacturer().trim();
    const core = this.core().trim();

    return this.systems.value().filter((system) => {
      if (kind !== '' && system.kind_id !== kind) {
        return false;
      }
      if (maker !== '' && system.manufacturer_id !== maker) {
        return false;
      }
      if (core === 'yes' && system.core_count === 0) {
        return false;
      }
      if (core === 'no' && system.core_count > 0) {
        return false;
      }
      return matchesText(term, system.name, system.system_id);
    });
  });

  protected readonly withCore = computed(
    () => this.systems.value().filter((system) => system.core_count > 0).length,
  );

  protected setParam(key: string, event: Event): void {
    this.write({ [key]: paramValue(controlValue(event)) });
  }

  protected reset(): void {
    this.write({ q: null, kind: null, manufacturer: null, core: null });
  }
}
