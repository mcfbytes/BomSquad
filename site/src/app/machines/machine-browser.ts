import { Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { DataStatus } from '../data/data-status';
import { DatabaseService } from '../data/database';
import { isPending, query, queryAll } from '../data/query';
import { CoverageBadge } from '../shared/coverage-badge';
import { UNKNOWN, formatCount } from '../shared/format';
import {
  controlValue,
  matchesText,
  param,
  paramValue,
  queryParamWriter,
} from '../shared/url-filters';

const PAGE_SIZE = 50;

interface MachineListRow {
  readonly machine_id: string;
  readonly name: string;
  readonly year: number | null;
  readonly manufacturer_id: string | null;
  readonly system_id: string | null;
  readonly driver_status: string | null;
  readonly chips_total: number;
  readonly chips_satisfied: number;
  readonly unmapped_devices: number;
  readonly has_core: 0 | 1;
}

/**
 * The whole machine table with its FPGA coverage, in one statement.
 *
 * **This is the one number on the site the schema's views could not answer.** There is
 * a `v_system_coverage_by_kind` but no `v_machine_coverage`: coverage is defined per
 * *system* (coverage.md §3.4), and a machine-level figure has to be re-derived from
 * `v_machine_bom` against `v_chip_evidence`. The derivation below is deliberately the
 * same shape as the system one — count distinct sockets, count the ones any evidence
 * rank reaches — so the two agree wherever a machine's BOM is its system's.
 *
 * `manufacturer` and `system` names are *not* selected: joining them here would repeat
 * 67 and 69 short strings across 9 775 rows for no benefit, and the lookup tables are
 * already loaded for the filter controls.
 */
const MACHINE_LIST_SQL = `
WITH cov AS (
  SELECT b.machine_id,
         COUNT(DISTINCT b.chip_id) AS chips_total,
         COUNT(DISTINCT CASE WHEN e.chip_id IS NOT NULL THEN b.chip_id END) AS chips_satisfied
  FROM v_machine_bom b
  LEFT JOIN v_chip_evidence e ON e.kind_id = 'fpga_hdl' AND e.chip_id = b.chip_id
  GROUP BY b.machine_id
),
unmapped AS (
  SELECT machine_id, COUNT(DISTINCT mame_device) AS unmapped_devices
  FROM machine_unmapped_device
  GROUP BY machine_id
),
cored AS (
  SELECT machine_id FROM implementation_machine
  UNION
  SELECT vms.machine_id
  FROM v_machine_system vms
  JOIN implementation_system isy ON isy.system_id = vms.system_id
)
SELECT m.machine_id, m.name, m.year, m.manufacturer_id, m.system_id, m.driver_status,
       COALESCE(c.chips_total, 0)        AS chips_total,
       COALESCE(c.chips_satisfied, 0)    AS chips_satisfied,
       COALESCE(u.unmapped_devices, 0)   AS unmapped_devices,
       CASE WHEN k.machine_id IS NULL THEN 0 ELSE 1 END AS has_core
FROM v_machine m
LEFT JOIN cov c      ON c.machine_id = m.machine_id
LEFT JOIN unmapped u ON u.machine_id = m.machine_id
LEFT JOIN cored k    ON k.machine_id = m.machine_id
ORDER BY m.name, m.machine_id`;

type SortKey = 'name' | 'year' | 'coverage' | 'unmapped';

const SORT_LABELS: Readonly<Record<SortKey, string>> = {
  name: 'name',
  year: 'year',
  coverage: 'coverage',
  unmapped: 'uncatalogued device count',
};

/**
 * Machine / board browser (PLAN §5 view 4, TASKS T7.5).
 *
 * 9 775 machines arrive in one statement and are filtered in signals. That is a
 * deliberate repeat of ADR 0001's bargain one level down: the alternative is a
 * `SELECT` with a seven-way `WHERE` and a `COUNT(*)` twin on every keystroke, each
 * paying the full coverage aggregate again, to narrow a list already in memory.
 */
@Component({
  selector: 'app-machine-browser',
  imports: [RouterLink, CoverageBadge, DataStatus],
  template: `
    <header class="view__head">
      <p class="eyebrow">Boards, consoles &amp; handhelds</p>
      <h1>Machines</h1>
      <p class="view__lede">
        Every machine MAME describes that survived the extraction filter, with how much of its bill
        of materials the open FPGA world already covers.
      </p>
    </header>

    <form class="filters" (submit)="$event.preventDefault()">
      <div class="filters__field filters__field--wide">
        <label class="filters__label" for="machine-q">Name or MAME id contains</label>
        <input
          id="machine-q"
          class="filters__control"
          type="search"
          autocomplete="off"
          [value]="q()"
          (input)="setParam('q', $event)"
        />
      </div>

      <div class="filters__field">
        <label class="filters__label" for="machine-kind">Kind</label>
        <select
          id="machine-kind"
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
        <label class="filters__label" for="machine-manufacturer">Manufacturer</label>
        <select
          id="machine-manufacturer"
          class="filters__control"
          [value]="manufacturer()"
          (change)="setParam('manufacturer', $event)"
        >
          <option value="">All manufacturers</option>
          @for (row of manufacturers.value(); track row.manufacturer_id) {
            <option [value]="row.manufacturer_id">{{ row.name }}</option>
          }
        </select>
      </div>

      <div class="filters__field">
        <label class="filters__label" for="machine-family">Platform family</label>
        <select
          id="machine-family"
          class="filters__control"
          [value]="family()"
          (change)="setParam('family', $event)"
        >
          <option value="">All families</option>
          <option value="none">No family assigned</option>
          @for (row of systems.value(); track row.system_id) {
            <option [value]="row.system_id">{{ row.name }}</option>
          }
        </select>
      </div>

      <div class="filters__field filters__field--narrow">
        <label class="filters__label" for="machine-from">Year from</label>
        <input
          id="machine-from"
          class="filters__control"
          type="number"
          inputmode="numeric"
          min="1950"
          max="2100"
          [value]="from()"
          (input)="setParam('from', $event)"
        />
      </div>

      <div class="filters__field filters__field--narrow">
        <label class="filters__label" for="machine-to">Year to</label>
        <input
          id="machine-to"
          class="filters__control"
          type="number"
          inputmode="numeric"
          min="1950"
          max="2100"
          [value]="to()"
          (input)="setParam('to', $event)"
        />
      </div>

      <div class="filters__field filters__field--narrow">
        <label class="filters__label" for="machine-coverage">Coverage ≥ %</label>
        <input
          id="machine-coverage"
          class="filters__control"
          type="number"
          inputmode="numeric"
          min="0"
          max="100"
          step="5"
          [value]="coverage()"
          (input)="setParam('coverage', $event)"
        />
      </div>

      <div class="filters__field filters__field--narrow">
        <label class="filters__label" for="machine-core">Core exists</label>
        <select
          id="machine-core"
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
      [error]="machines.error()"
      loadingLabel="Loading machines and their coverage…"
      (retry)="machines.reload()"
    />

    @if (!pending() && machines.error() === undefined) {
      <p class="result-count">
        <strong>{{ formatCount(rows().length) }}</strong> of
        {{ formatCount(machines.value().length) }} machines. {{ formatCount(coredCount()) }} of the
        whole set already have an FPGA core, directly or through their platform family.
      </p>

      @if (rows().length === 0) {
        <p class="empty">No machine matches these filters.</p>
      } @else {
        <div class="table-scroll">
          <table>
            <caption>
              Sorted by
              {{
                sortLabel()
              }},
              {{
                descending() ? 'descending' : 'ascending'
              }}. Coverage is this machine's BOM against
              <code>fpga_hdl</code>
              implementations.
            </caption>
            <thead>
              <tr>
                @for (column of columns; track column.label) {
                  <th
                    scope="col"
                    [class.num]="column.numeric"
                    [attr.aria-sort]="ariaSort(column.key)"
                  >
                    @if (column.key === null) {
                      {{ column.label }}
                    } @else {
                      <button type="button" class="th-sort" (click)="sortBy(column.key)">
                        {{ column.label }}{{ sortMarker(column.key) }}
                      </button>
                    }
                  </th>
                }
              </tr>
            </thead>
            <tbody>
              @for (machine of visibleRows(); track machine.machine_id) {
                <tr>
                  <th scope="row">
                    <a [routerLink]="['/machine', machine.machine_id]">{{ machine.name }}</a>
                    <br />
                    <code class="subtle">{{ machine.machine_id }}</code>
                  </th>
                  <td class="num">{{ machine.year ?? unknown }}</td>
                  <td>{{ manufacturerName(machine.manufacturer_id) }}</td>
                  <td>
                    @if (machine.system_id; as system) {
                      <a [routerLink]="['/system', system]">{{ systemName(system) }}</a>
                    } @else {
                      <span class="subtle">{{ unknown }}</span>
                    }
                  </td>
                  <td>
                    <app-coverage-badge
                      size="sm"
                      [covered]="machine.chips_satisfied"
                      [total]="machine.chips_total"
                    />
                  </td>
                  <td class="num">
                    @if (machine.unmapped_devices > 0) {
                      <span class="tag tag--muted">{{ machine.unmapped_devices }}</span>
                    } @else {
                      0
                    }
                  </td>
                  <td>
                    @if (machine.has_core === 1) {
                      <span class="tag tag--ok">core</span>
                    } @else {
                      <span class="subtle">none</span>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>

        @if (visibleRows().length < rows().length) {
          <div class="pager">
            <button type="button" class="pixel-button" (click)="showMore()">
              Show {{ formatCount(nextPageSize()) }} more
            </button>
            <p class="pager__status">
              Showing {{ formatCount(visibleRows().length) }} of {{ formatCount(rows().length) }}.
            </p>
          </div>
        }
      }
    }
  `,
  styles: `
    :host {
      display: block;
    }

    .subtle {
      font-size: 0.8125rem;
      color: var(--muted);
    }
  `,
})
export class MachineBrowser {
  private readonly database = inject(DatabaseService);
  private readonly write = queryParamWriter();

  readonly q = input('', { transform: param });
  readonly kind = input('', { transform: param });
  readonly manufacturer = input('', { transform: param });
  readonly family = input('', { transform: param });
  readonly from = input('', { transform: param });
  readonly to = input('', { transform: param });
  readonly coverage = input('', { transform: param });
  readonly core = input('', { transform: param });
  readonly sort = input('', { transform: param });
  readonly dir = input('', { transform: param });

  protected readonly unknown = UNKNOWN;
  protected readonly formatCount = formatCount;

  protected readonly columns: readonly {
    readonly key: SortKey | null;
    readonly label: string;
    readonly numeric: boolean;
  }[] = [
    { key: 'name', label: 'Machine', numeric: false },
    { key: 'year', label: 'Year', numeric: true },
    { key: null, label: 'Manufacturer', numeric: false },
    { key: null, label: 'Family', numeric: false },
    { key: 'coverage', label: 'Coverage', numeric: false },
    { key: 'unmapped', label: 'Unmapped', numeric: true },
    { key: null, label: 'Core', numeric: false },
  ];

  protected readonly machines = query<MachineListRow>(() => ({ sql: MACHINE_LIST_SQL }));
  protected readonly kinds = queryAll('system_kind', { orderBy: 'label' });
  protected readonly manufacturers = queryAll('manufacturer', { orderBy: 'name' });
  protected readonly systems = queryAll('system', { orderBy: 'name' });

  protected readonly pending = computed(
    () => isPending(this.machines)() || this.database.isLoading(),
  );

  private readonly manufacturerNames = computed(
    () => new Map(this.manufacturers.value().map((row) => [row.manufacturer_id, row.name])),
  );

  private readonly systemById = computed(
    () => new Map(this.systems.value().map((row) => [row.system_id, row])),
  );

  protected manufacturerName(id: string | null): string {
    return id === null ? UNKNOWN : (this.manufacturerNames().get(id) ?? id);
  }

  protected systemName(id: string): string {
    return this.systemById().get(id)?.name ?? id;
  }

  protected readonly sortKey = computed<SortKey>(() => {
    const requested = this.sort();
    return Object.hasOwn(SORT_LABELS, requested) ? (requested as SortKey) : 'name';
  });

  protected readonly descending = computed(() => {
    const requested = this.dir();
    if (requested === 'asc' || requested === 'desc') {
      return requested === 'desc';
    }
    return this.sortKey() !== 'name';
  });

  protected readonly sortLabel = computed(() => SORT_LABELS[this.sortKey()]);

  protected readonly rows = computed(() => {
    const term = this.q();
    const kind = this.kind().trim();
    const maker = this.manufacturer().trim();
    const family = this.family().trim();
    const from = numberOrNull(this.from());
    const to = numberOrNull(this.to());
    const minCoverage = numberOrNull(this.coverage());
    const core = this.core().trim();
    const systems = this.systemById();

    const filtered = this.machines.value().filter((machine) => {
      if (maker !== '' && machine.manufacturer_id !== maker) {
        return false;
      }
      if (family === 'none' && machine.system_id !== null) {
        return false;
      }
      if (family !== '' && family !== 'none' && machine.system_id !== family) {
        return false;
      }
      if (kind !== '') {
        const system = machine.system_id === null ? undefined : systems.get(machine.system_id);
        if (system?.kind_id !== kind) {
          return false;
        }
      }
      if (from !== null && (machine.year === null || machine.year < from)) {
        return false;
      }
      if (to !== null && (machine.year === null || machine.year > to)) {
        return false;
      }
      if (minCoverage !== null && share(machine) * 100 < minCoverage) {
        return false;
      }
      if (core === 'yes' && machine.has_core !== 1) {
        return false;
      }
      if (core === 'no' && machine.has_core === 1) {
        return false;
      }
      return matchesText(term, machine.name, machine.machine_id);
    });

    const direction = this.descending() ? -1 : 1;
    const key = this.sortKey();
    return [...filtered].sort(
      (a, b) => direction * compare(a, b, key) || a.machine_id.localeCompare(b.machine_id),
    );
  });

  protected readonly coredCount = computed(
    () => this.machines.value().filter((machine) => machine.has_core === 1).length,
  );

  private readonly pages = signal(1);

  protected readonly visibleRows = computed(() => this.rows().slice(0, this.pages() * PAGE_SIZE));

  protected readonly nextPageSize = computed(() =>
    Math.min(PAGE_SIZE, this.rows().length - this.visibleRows().length),
  );

  protected ariaSort(key: SortKey | null): 'ascending' | 'descending' | 'none' {
    if (key === null || this.sortKey() !== key) {
      return 'none';
    }
    return this.descending() ? 'descending' : 'ascending';
  }

  protected sortMarker(key: SortKey): string {
    if (this.sortKey() !== key) {
      return '';
    }
    return this.descending() ? ' ↓' : ' ↑';
  }

  protected sortBy(key: SortKey): void {
    if (this.sortKey() === key) {
      this.write({ sort: key, dir: this.descending() ? 'asc' : 'desc' });
      return;
    }
    this.write({ sort: key, dir: null });
  }

  protected setParam(key: string, event: Event): void {
    this.write({ [key]: paramValue(controlValue(event)) });
  }

  protected reset(): void {
    this.write({
      q: null,
      kind: null,
      manufacturer: null,
      family: null,
      from: null,
      to: null,
      coverage: null,
      core: null,
      sort: null,
      dir: null,
    });
  }

  protected showMore(): void {
    this.pages.update((count) => count + 1);
  }
}

function numberOrNull(raw: string): number | null {
  const value = Number(raw.trim());
  return raw.trim() === '' || !Number.isFinite(value) ? null : value;
}

/** A machine with no catalogued chips has no coverage, which is not the same as 0 %. */
function share(machine: MachineListRow): number {
  return machine.chips_total === 0 ? 0 : machine.chips_satisfied / machine.chips_total;
}

function compare(a: MachineListRow, b: MachineListRow, key: SortKey): number {
  switch (key) {
    case 'name':
      return a.name.localeCompare(b.name);
    case 'year':
      return (a.year ?? 0) - (b.year ?? 0);
    case 'coverage':
      return share(a) - share(b) || a.chips_total - b.chips_total;
    case 'unmapped':
      return a.unmapped_devices - b.unmapped_devices;
  }
}
