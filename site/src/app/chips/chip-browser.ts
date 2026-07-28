import { Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { DataStatus } from '../data/data-status';
import { DatabaseService } from '../data/database';
import { isPending, query, queryAll } from '../data/query';
import { UNKNOWN, formatCount } from '../shared/format';
import {
  controlValue,
  matchesText,
  param,
  paramValue,
  queryParamWriter,
} from '../shared/url-filters';

/** Rows rendered before "show more" — 169 chips is small, but the DOM still is not free. */
const PAGE_SIZE = 60;

/**
 * One chip with everything the browser sorts, filters and shows.
 *
 * `machine_count` reads `v_machine_bom`, not `machine_chip`: a chip a system contributes
 * to every one of its machines is genuinely in those machines' BOMs, and counting only
 * the per-machine MAME rows would understate every curated chipset.
 */
interface ChipListRow {
  readonly chip_id: string;
  readonly display_name: string;
  readonly function_id: string;
  readonly function_label: string;
  readonly prospector_band: string;
  readonly manufacturer_id: string | null;
  readonly manufacturer_name: string | null;
  readonly year_introduced: number | null;
  readonly fpga_implementations: number;
  readonly machine_count: number;
  readonly system_count: number;
  /** `self` · `equivalent` · `provides` from `v_chip_evidence`, or NULL for a gap. */
  readonly best_via: string | null;
}

const CHIP_LIST_SQL = `
SELECT c.chip_id, c.display_name, c.function_id, cf.label AS function_label,
       cf.prospector_band, c.manufacturer_id, mf.name AS manufacturer_name, c.year_introduced,
       COALESCE(ic.implementation_count, 0) AS fpga_implementations,
       (SELECT COUNT(DISTINCT b.machine_id) FROM v_machine_bom b
         WHERE b.chip_id = c.chip_id) AS machine_count,
       (SELECT COUNT(DISTINCT sc.system_id) FROM v_system_chip_effective sc
         WHERE sc.chip_id = c.chip_id) AS system_count,
       e.best_via
FROM chip c
JOIN chip_function cf     ON cf.function_id = c.function_id
LEFT JOIN manufacturer mf ON mf.manufacturer_id = c.manufacturer_id
LEFT JOIN v_chip_implementation_count ic
       ON ic.chip_id = c.chip_id AND ic.kind_id = 'fpga_hdl'
LEFT JOIN v_chip_evidence e ON e.chip_id = c.chip_id AND e.kind_id = 'fpga_hdl'
ORDER BY c.chip_id`;

type SortKey = 'machines' | 'systems' | 'implementations' | 'name' | 'year';

const SORT_LABELS: Readonly<Record<SortKey, string>> = {
  machines: 'machine count',
  systems: 'system count',
  implementations: 'FPGA core count',
  name: 'name',
  year: 'year',
};

/**
 * Chip browser (PLAN §5 view 2, TASKS T7.4).
 *
 * The whole catalogue is 169 rows, so it is fetched once and filtered in signals rather
 * than re-queried per keystroke: a `SELECT` per character would be a round trip through
 * the wasm boundary to narrow a list already in memory.
 *
 * "FPGA status" deliberately has more than one positive answer. A chip whose only
 * coverage arrives through a curated `chip_equivalence` edge is not in the same position
 * as one an implementation names outright — `v_chip_evidence` ranks the two differently
 * — so the filter and the table both say which it is.
 */
@Component({
  selector: 'app-chip-browser',
  imports: [RouterLink, DataStatus],
  template: `
    <header class="view__head">
      <p class="eyebrow">The catalogue</p>
      <h1>Chips</h1>
      <p class="view__lede">
        Every part in the catalogue: what it does, how many machines carry it, and whether the
        open-source FPGA world has covered it yet.
      </p>
    </header>

    <form class="filters" (submit)="$event.preventDefault()">
      <div class="filters__field filters__field--wide">
        <label class="filters__label" for="chip-q">Name or id contains</label>
        <input
          id="chip-q"
          class="filters__control"
          type="search"
          autocomplete="off"
          [value]="q()"
          (input)="setParam('q', $event)"
        />
      </div>

      <div class="filters__field">
        <label class="filters__label" for="chip-function">Function</label>
        <select
          id="chip-function"
          class="filters__control"
          [value]="fn()"
          (change)="setParam('fn', $event)"
        >
          <option value="">All functions</option>
          @for (row of functions.value(); track row.function_id) {
            <option [value]="row.function_id">{{ row.label }}</option>
          }
        </select>
      </div>

      <div class="filters__field">
        <label class="filters__label" for="chip-manufacturer">Manufacturer</label>
        <select
          id="chip-manufacturer"
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

      <div class="filters__field">
        <label class="filters__label" for="chip-status">FPGA status</label>
        <select
          id="chip-status"
          class="filters__control"
          [value]="status()"
          (change)="setParam('status', $event)"
        >
          <option value="">Any status</option>
          <option value="implemented">Implemented directly</option>
          <option value="equivalent">Only via equivalence</option>
          <option value="covered">Covered either way</option>
          <option value="missing">No implementation</option>
        </select>
      </div>

      <div class="filters__actions">
        <button type="button" class="pixel-button" (click)="reset()">Reset</button>
      </div>
    </form>

    <app-data-status
      [loading]="pending()"
      [error]="chips.error()"
      loadingLabel="Loading the chip catalogue…"
      (retry)="chips.reload()"
    />

    @if (!pending() && chips.error() === undefined) {
      <p class="result-count">
        <strong>{{ formatCount(rows().length) }}</strong> of
        {{ formatCount(chips.value().length) }} chips. {{ formatCount(coveredCount()) }} in the
        catalogue have an FPGA implementation, directly or through an equivalence.
      </p>

      @if (rows().length === 0) {
        <p class="empty">No chip matches these filters.</p>
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
              }}. Column headers sort.
            </caption>
            <thead>
              <tr>
                @for (column of columns; track column.key) {
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
              @for (chip of visibleRows(); track chip.chip_id) {
                <tr>
                  <th scope="row">
                    <a [routerLink]="['/chip', chip.chip_id]">{{ chip.display_name }}</a>
                  </th>
                  <td>
                    {{ chip.function_label }}
                    <span
                      class="tag"
                      [class.tag--bad]="chip.prospector_band === 'hard'"
                      [class.tag--warn]="chip.prospector_band === 'medium'"
                      [class.tag--muted]="chip.prospector_band === 'soft'"
                      >{{ chip.prospector_band }}</span
                    >
                  </td>
                  <td>{{ chip.manufacturer_name ?? unknown }}</td>
                  <td class="num">{{ chip.year_introduced ?? unknown }}</td>
                  <td class="num">{{ formatCount(chip.machine_count) }}</td>
                  <td class="num">{{ formatCount(chip.system_count) }}</td>
                  <td class="num">{{ formatCount(chip.fpga_implementations) }}</td>
                  <td>
                    @switch (chip.best_via) {
                      @case ('self') {
                        <span class="tag tag--ok">implemented</span>
                      }
                      @case (null) {
                        <span class="tag tag--bad">missing</span>
                      }
                      @default {
                        <span class="tag tag--warn">via {{ chip.best_via }}</span>
                      }
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
              Show {{ formatCount(rows().length - visibleRows().length) }} more
            </button>
            <p class="pager__status">
              Showing {{ visibleRows().length }} of {{ formatCount(rows().length) }}.
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
  `,
})
export class ChipBrowser {
  private readonly database = inject(DatabaseService);
  private readonly write = queryParamWriter();

  readonly q = input('', { transform: param });
  readonly fn = input('', { transform: param });
  readonly manufacturer = input('', { transform: param });
  readonly status = input('', { transform: param });
  readonly sort = input('', { transform: param });
  readonly dir = input('', { transform: param });

  protected readonly unknown = UNKNOWN;
  protected readonly formatCount = formatCount;

  protected readonly columns: readonly {
    readonly key: SortKey | null;
    readonly label: string;
    readonly numeric: boolean;
  }[] = [
    { key: 'name', label: 'Chip', numeric: false },
    { key: null, label: 'Function', numeric: false },
    { key: null, label: 'Manufacturer', numeric: false },
    { key: 'year', label: 'Year', numeric: true },
    { key: 'machines', label: 'Machines', numeric: true },
    { key: 'systems', label: 'Systems', numeric: true },
    { key: 'implementations', label: 'FPGA cores', numeric: true },
    { key: null, label: 'FPGA status', numeric: false },
  ];

  protected readonly chips = query<ChipListRow>(() => ({ sql: CHIP_LIST_SQL }));
  protected readonly functions = queryAll('chip_function', { orderBy: 'label' });

  protected readonly pending = computed(() => isPending(this.chips)() || this.database.isLoading());

  protected readonly sortKey = computed<SortKey>(() => {
    const requested = this.sort();
    return Object.hasOwn(SORT_LABELS, requested) ? (requested as SortKey) : 'machines';
  });

  /** Counts read best descending, names ascending. The URL can always say otherwise. */
  protected readonly descending = computed(() => {
    const requested = this.dir();
    if (requested === 'asc' || requested === 'desc') {
      return requested === 'desc';
    }
    return this.sortKey() !== 'name';
  });

  protected readonly sortLabel = computed(() => SORT_LABELS[this.sortKey()]);

  protected readonly manufacturersInPlay = computed(() => {
    const names = new Map<string, string>();
    for (const chip of this.chips.value()) {
      if (chip.manufacturer_id !== null) {
        names.set(chip.manufacturer_id, chip.manufacturer_name ?? chip.manufacturer_id);
      }
    }
    return [...names]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  protected readonly rows = computed(() => {
    const term = this.q();
    const fn = this.fn().trim();
    const maker = this.manufacturer().trim();
    const status = this.status().trim();
    const direction = this.descending() ? -1 : 1;
    const key = this.sortKey();

    const filtered = this.chips.value().filter((chip) => {
      if (fn !== '' && chip.function_id !== fn) {
        return false;
      }
      if (maker !== '' && chip.manufacturer_id !== maker) {
        return false;
      }
      if (!matchesStatus(chip, status)) {
        return false;
      }
      return matchesText(term, chip.display_name, chip.chip_id);
    });

    return [...filtered].sort(
      (a, b) => direction * compare(a, b, key) || a.chip_id.localeCompare(b.chip_id),
    );
  });

  protected readonly coveredCount = computed(
    () => this.chips.value().filter((chip) => chip.best_via !== null).length,
  );

  private readonly pages = signal(1);

  protected readonly visibleRows = computed(() => this.rows().slice(0, this.pages() * PAGE_SIZE));

  protected ariaSort(key: SortKey | null): 'ascending' | 'descending' | 'none' {
    if (key === null || this.sortKey() !== key) {
      return 'none';
    }
    return this.descending() ? 'descending' : 'ascending';
  }

  /** A text marker beside the label, so the sorted column is not signalled by colour alone. */
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
    this.write({ q: null, fn: null, manufacturer: null, status: null, sort: null, dir: null });
  }

  protected showMore(): void {
    this.pages.update((count) => count + 1);
  }
}

function matchesStatus(chip: ChipListRow, status: string): boolean {
  switch (status) {
    case 'implemented':
      return chip.best_via === 'self';
    case 'equivalent':
      return chip.best_via === 'equivalent' || chip.best_via === 'provides';
    case 'covered':
      return chip.best_via !== null;
    case 'missing':
      return chip.best_via === null;
    default:
      return true;
  }
}

function compare(a: ChipListRow, b: ChipListRow, key: SortKey): number {
  switch (key) {
    case 'name':
      return a.display_name.localeCompare(b.display_name);
    case 'year':
      return (a.year_introduced ?? 0) - (b.year_introduced ?? 0);
    case 'implementations':
      return a.fpga_implementations - b.fpga_implementations;
    case 'systems':
      return a.system_count - b.system_count;
    case 'machines':
      return a.machine_count - b.machine_count;
  }
}
