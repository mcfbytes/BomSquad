import { Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { DataStatus } from '../data/data-status';
import { DatabaseService } from '../data/database';
import { isPending, query, queryAll } from '../data/query';
import { UNKNOWN, formatCount, pluralize } from '../shared/format';
import {
  controlValue,
  matchesText,
  param,
  paramValue,
  queryParamWriter,
} from '../shared/url-filters';

const PAGE_SIZE = 50;

interface ImplementationRow {
  readonly implementation_id: string;
  readonly name: string;
  readonly repo_url: string | null;
  readonly license_id: string | null;
  readonly license_name: string | null;
  readonly is_osi_approved: 0 | 1 | null;
  readonly accuracy_id: string | null;
  readonly accuracy_label: string | null;
  readonly hdl_language_id: string | null;
  readonly language_label: string | null;
  readonly project_id: string | null;
  readonly project_name: string | null;
  readonly author: string | null;
  readonly verified_against_hardware: 0 | 1 | null;
  readonly last_reviewed: string | null;
  readonly resource_notes: string | null;
  readonly notes: string | null;
  readonly chip_count: number;
  readonly machine_count: number;
  readonly system_count: number;
  readonly consumer_count: number;
}

const IMPLEMENTATION_LIST_SQL = `
SELECT i.implementation_id, i.name, i.repo_url,
       i.license_id, l.name AS license_name, l.is_osi_approved,
       i.accuracy_id, a.label AS accuracy_label,
       i.hdl_language_id, hl.label AS language_label,
       i.project_id, p.name AS project_name, p.author,
       i.verified_against_hardware, i.last_reviewed, i.resource_notes, i.notes,
       (SELECT COUNT(*) FROM implementation_chip ic
         WHERE ic.implementation_id = i.implementation_id) AS chip_count,
       (SELECT COUNT(*) FROM implementation_machine im
         WHERE im.implementation_id = i.implementation_id) AS machine_count,
       (SELECT COUNT(*) FROM implementation_system isy
         WHERE isy.implementation_id = i.implementation_id) AS system_count,
       (SELECT COUNT(*) FROM implementation_dependency d
         WHERE d.provider_id = i.implementation_id) AS consumer_count
FROM implementation i
LEFT JOIN license l        ON l.license_id = i.license_id
LEFT JOIN accuracy_level a ON a.accuracy_id = i.accuracy_id
LEFT JOIN hdl_language hl  ON hl.language_id = i.hdl_language_id
LEFT JOIN project p        ON p.project_id = i.project_id
ORDER BY i.name, i.implementation_id`;

/** 531 rows across the whole catalogue — cheaper as one statement than 400 lazy ones. */
const PLATFORM_SQL = `
SELECT ip.implementation_id, ip.platform_id, fp.label
FROM implementation_platform ip
JOIN fpga_platform fp ON fp.platform_id = ip.platform_id
ORDER BY ip.implementation_id, fp.label`;

/**
 * Implementation browser (PLAN §5 view 8, TASKS T7.8).
 *
 * Filterable by language, licence, accuracy, author/project and target platform, with
 * every filter in the URL. Global search (T7.3) links an implementation hit here as
 * `?implementation=<id>`, because PLAN §5 gives implementations a browser and no detail
 * route — so this view honours that parameter by expanding the row in place, which keeps
 * the link a real permalink without inventing a tenth view.
 *
 * The catalogue is honest about its own gaps: a missing licence or accuracy shows as a
 * red `unverified` tag rather than as a blank cell, because "nobody has checked" is a
 * fact a contributor can act on and an empty cell is not.
 */
@Component({
  selector: 'app-implementation-browser',
  imports: [RouterLink, DataStatus],
  template: `
    <header class="view__head">
      <p class="eyebrow">Open HDL</p>
      <h1>Implementations</h1>
      <p class="view__lede">
        Every known open-source implementation of catalogued silicon — chip cores, whole-board
        cores, and the IP they depend on.
      </p>
    </header>

    <form class="filters" (submit)="$event.preventDefault()">
      <div class="filters__field filters__field--wide">
        <label class="filters__label" for="impl-q">Name, id or author contains</label>
        <input
          id="impl-q"
          class="filters__control"
          type="search"
          autocomplete="off"
          [value]="q()"
          (input)="setParam('q', $event)"
        />
      </div>

      <div class="filters__field">
        <label class="filters__label" for="impl-language">Language</label>
        <select
          id="impl-language"
          class="filters__control"
          [value]="language()"
          (change)="setParam('language', $event)"
        >
          <option value="">All languages</option>
          @for (row of languages.value(); track row.language_id) {
            <option [value]="row.language_id">{{ row.label }}</option>
          }
        </select>
      </div>

      <div class="filters__field">
        <label class="filters__label" for="impl-license">Licence</label>
        <select
          id="impl-license"
          class="filters__control"
          [value]="license()"
          (change)="setParam('license', $event)"
        >
          <option value="">All licences</option>
          <option value="none">Unverified</option>
          @for (row of licensesInPlay(); track row) {
            <option [value]="row">{{ row }}</option>
          }
        </select>
      </div>

      <div class="filters__field">
        <label class="filters__label" for="impl-accuracy">Accuracy</label>
        <select
          id="impl-accuracy"
          class="filters__control"
          [value]="accuracy()"
          (change)="setParam('accuracy', $event)"
        >
          <option value="">All levels</option>
          <option value="none">Unassessed</option>
          @for (row of accuracyLevels.value(); track row.accuracy_id) {
            <option [value]="row.accuracy_id">{{ row.label }}</option>
          }
        </select>
      </div>

      <div class="filters__field">
        <label class="filters__label" for="impl-project">Project / author</label>
        <select
          id="impl-project"
          class="filters__control"
          [value]="project()"
          (change)="setParam('project', $event)"
        >
          <option value="">All projects</option>
          @for (row of projectsInPlay(); track row.id) {
            <option [value]="row.id">{{ row.name }}</option>
          }
        </select>
      </div>

      <div class="filters__field">
        <label class="filters__label" for="impl-platform">Platform</label>
        <select
          id="impl-platform"
          class="filters__control"
          [value]="platform()"
          (change)="setParam('platform', $event)"
        >
          <option value="">All platforms</option>
          @for (row of platforms.value(); track row.platform_id) {
            <option [value]="row.platform_id">{{ row.label }}</option>
          }
        </select>
      </div>

      <div class="filters__actions">
        <button type="button" class="pixel-button" (click)="reset()">Reset</button>
      </div>
    </form>

    <app-data-status
      [loading]="pending()"
      [error]="implementations.error()"
      loadingLabel="Loading the implementation catalogue…"
      (retry)="implementations.reload()"
    />

    @if (!pending() && implementations.error() === undefined) {
      <p class="result-count">
        <strong>{{ formatCount(rows().length) }}</strong> of
        {{ formatCount(implementations.value().length) }} implementations.
        {{ formatCount(withLicense()) }} carry a verified licence and
        {{ formatCount(withAccuracy()) }} an assessed accuracy — the rest are
        <a routerLink="/contribute">waiting on somebody to check</a>.
      </p>

      @if (rows().length === 0) {
        <p class="empty">No implementation matches these filters.</p>
      } @else {
        <div class="table-scroll">
          <table>
            <caption>
              Sorted by name. Expand a row for the chips, targets and dependencies it declares.
            </caption>
            <thead>
              <tr>
                <th scope="col">Implementation</th>
                <th scope="col">Language</th>
                <th scope="col">Licence</th>
                <th scope="col">Accuracy</th>
                <th scope="col">Project</th>
                <th scope="col">Targets</th>
                <th scope="col">Platforms</th>
              </tr>
            </thead>
            <tbody>
              @for (impl of visibleRows(); track impl.implementation_id) {
                <tr [class.is-open]="isOpen(impl.implementation_id)">
                  <th scope="row">
                    @if (impl.repo_url; as url) {
                      <a [href]="url" rel="noopener nofollow">{{ impl.name }}</a>
                    } @else {
                      {{ impl.name }}
                    }
                    <br />
                    <button
                      type="button"
                      class="link-button"
                      [attr.aria-expanded]="isOpen(impl.implementation_id)"
                      [attr.aria-controls]="'impl-' + impl.implementation_id"
                      (click)="toggle(impl.implementation_id)"
                    >
                      {{ impl.implementation_id }}
                    </button>
                  </th>
                  <td>{{ impl.language_label ?? unknown }}</td>
                  <td>
                    @if (impl.license_id; as id) {
                      <span class="tag" [title]="impl.license_name ?? id">{{ id }}</span>
                      @if (impl.is_osi_approved === 1) {
                        <span class="sr-only">OSI approved</span>
                      }
                    } @else {
                      <span class="tag tag--bad">unverified</span>
                    }
                  </td>
                  <td>
                    @if (impl.accuracy_label; as label) {
                      <span class="tag">{{ label }}</span>
                    } @else {
                      <span class="tag tag--bad">unassessed</span>
                    }
                    @if (impl.verified_against_hardware === 1) {
                      <span class="tag tag--ok">hw</span>
                    }
                  </td>
                  <td>{{ impl.author ?? impl.project_name ?? unknown }}</td>
                  <td class="nowrap">
                    {{ impl.chip_count }} chip / {{ impl.machine_count }} machine /
                    {{ impl.system_count }} family
                    @if (impl.consumer_count > 0) {
                      <br />
                      <span class="tag tag--muted"
                        >used by {{ formatCount(impl.consumer_count) }}</span
                      >
                    }
                  </td>
                  <td>
                    @for (
                      platform of platformsFor(impl.implementation_id);
                      track platform.platform_id
                    ) {
                      <span class="tag tag--muted">{{ platform.label }}</span>
                    }
                  </td>
                </tr>
                @if (isOpen(impl.implementation_id)) {
                  <tr class="expansion">
                    <td colspan="7" [id]="'impl-' + impl.implementation_id">
                      <div class="expansion__cols">
                        <div>
                          <h3>Chips covered</h3>
                          @if (chips.value().length === 0) {
                            <p class="note">
                              This implementation declares no chip. Whole-board cores usually target
                              machines and families instead.
                            </p>
                          } @else {
                            <ul class="tag-row plain-list">
                              @for (chip of chips.value(); track chip.chip_id) {
                                <li>
                                  <a [routerLink]="['/chip', chip.chip_id]">{{
                                    chip.display_name
                                  }}</a>
                                </li>
                              }
                            </ul>
                          }

                          <h3>Families</h3>
                          @if (targetSystems.value().length === 0) {
                            <p class="note">No platform family declared.</p>
                          } @else {
                            <ul class="tag-row plain-list">
                              @for (system of targetSystems.value(); track system.system_id) {
                                <li>
                                  <a [routerLink]="['/system', system.system_id]">{{
                                    system.name
                                  }}</a>
                                </li>
                              }
                            </ul>
                          }
                        </div>

                        <div>
                          <h3>Machines</h3>
                          @if (targetMachines.value().length === 0) {
                            <p class="note">No machine declared.</p>
                          } @else {
                            <ul class="tag-row plain-list">
                              @for (machine of targetMachines.value(); track machine.machine_id) {
                                <li>
                                  <a [routerLink]="['/machine', machine.machine_id]">{{
                                    machine.name
                                  }}</a>
                                </li>
                              }
                            </ul>
                            @if (impl.machine_count > targetMachines.value().length) {
                              <p class="note">
                                Showing {{ targetMachines.value().length }} of
                                {{ impl.machine_count }}.
                              </p>
                            }
                          }
                        </div>

                        <div>
                          <h3>Depends on</h3>
                          @if (dependencies.value().length === 0) {
                            <p class="note">Nothing else in the catalogue.</p>
                          } @else {
                            <ul class="plain-list">
                              @for (dep of dependencies.value(); track dep.implementation_id) {
                                <li>
                                  <button
                                    type="button"
                                    class="link-button"
                                    (click)="toggle(dep.implementation_id)"
                                  >
                                    {{ dep.name }}
                                  </button>
                                  @if (dep.note; as note) {
                                    <span class="note">{{ note }}</span>
                                  }
                                </li>
                              }
                            </ul>
                          }

                          <h3>Consumed by</h3>
                          @if (consumers.value().length === 0) {
                            <p class="note">Nothing in the catalogue names it as a dependency.</p>
                          } @else {
                            <ul class="plain-list">
                              @for (
                                consumer of consumers.value();
                                track consumer.implementation_id
                              ) {
                                <li>
                                  <button
                                    type="button"
                                    class="link-button"
                                    (click)="toggle(consumer.implementation_id)"
                                  >
                                    {{ consumer.name }}
                                  </button>
                                </li>
                              }
                            </ul>
                          }
                        </div>
                      </div>

                      <dl class="meta">
                        <dt>Repository</dt>
                        <dd>
                          @if (impl.repo_url; as url) {
                            <a [href]="url" rel="noopener nofollow">{{ url }}</a>
                          } @else {
                            {{ unknown }}
                          }
                        </dd>
                        <dt>Last reviewed</dt>
                        <dd>{{ impl.last_reviewed ?? unknown }}</dd>
                        @if (impl.resource_notes; as resources) {
                          <dt>Resources</dt>
                          <dd>{{ resources }}</dd>
                        }
                        @if (impl.notes; as notes) {
                          <dt>Curator notes</dt>
                          <dd>{{ notes }}</dd>
                        }
                      </dl>
                    </td>
                  </tr>
                }
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

    .is-open > * {
      background: var(--surface);
    }

    .expansion > td {
      background: var(--surface);
      border-bottom: var(--border-w) solid var(--border);
    }

    .expansion__cols {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
      gap: 1.25rem;
      margin-bottom: 1rem;
    }

    .expansion__cols h3:not(:first-child) {
      margin-top: 1rem;
    }

    .note {
      margin: 0.25rem 0 0;
    }
  `,
})
export class ImplementationBrowser {
  private readonly database = inject(DatabaseService);
  private readonly write = queryParamWriter();

  readonly q = input('', { transform: param });
  readonly language = input('', { transform: param });
  readonly license = input('', { transform: param });
  readonly accuracy = input('', { transform: param });
  readonly project = input('', { transform: param });
  readonly platform = input('', { transform: param });
  /** Which row is expanded. T7.3 links here with this parameter set. */
  readonly implementation = input('', { transform: param });

  protected readonly unknown = UNKNOWN;
  protected readonly formatCount = formatCount;
  protected readonly pluralize = pluralize;

  protected readonly implementations = query<ImplementationRow>(() => ({
    sql: IMPLEMENTATION_LIST_SQL,
  }));

  private readonly implementationPlatforms = query<{
    readonly implementation_id: string;
    readonly platform_id: string;
    readonly label: string;
  }>(() => ({ sql: PLATFORM_SQL }));

  protected readonly languages = queryAll('hdl_language', { orderBy: 'label' });
  protected readonly accuracyLevels = queryAll('accuracy_level', { orderBy: 'label' });
  protected readonly platforms = queryAll('fpga_platform', { orderBy: 'label' });

  protected readonly pending = computed(
    () => isPending(this.implementations)() || this.database.isLoading(),
  );

  /** The expanded row's detail — one set of statements, not four hundred. */
  private detailSpec(sql: string, extra: Record<string, string | number> = {}) {
    return () => {
      const id = this.implementation().trim();
      return id === '' ? undefined : { sql, params: { ':id': id, ...extra } };
    };
  }

  protected readonly chips = query<{ readonly chip_id: string; readonly display_name: string }>(
    this.detailSpec(`
      SELECT ic.chip_id, c.display_name
      FROM implementation_chip ic
      JOIN chip c ON c.chip_id = ic.chip_id
      WHERE ic.implementation_id = :id
      ORDER BY c.display_name, ic.chip_id`),
  );

  protected readonly targetSystems = query<{
    readonly system_id: string;
    readonly name: string;
  }>(
    this.detailSpec(`
      SELECT isy.system_id, s.name
      FROM implementation_system isy
      JOIN system s ON s.system_id = isy.system_id
      WHERE isy.implementation_id = :id
      ORDER BY s.name, isy.system_id`),
  );

  protected readonly targetMachines = query<{
    readonly machine_id: string;
    readonly name: string;
  }>(
    this.detailSpec(
      `
      SELECT im.machine_id, m.name
      FROM implementation_machine im
      JOIN v_machine m ON m.machine_id = im.machine_id
      WHERE im.implementation_id = :id
      ORDER BY m.name, im.machine_id
      LIMIT :limit`,
      { ':limit': 40 },
    ),
  );

  protected readonly dependencies = query<{
    readonly implementation_id: string;
    readonly name: string;
    readonly note: string | null;
  }>(
    this.detailSpec(`
      SELECT d.provider_id AS implementation_id, i.name, d.note
      FROM implementation_dependency d
      JOIN implementation i ON i.implementation_id = d.provider_id
      WHERE d.consumer_id = :id
      ORDER BY i.name, d.provider_id`),
  );

  protected readonly consumers = query<{
    readonly implementation_id: string;
    readonly name: string;
  }>(
    this.detailSpec(`
      SELECT d.consumer_id AS implementation_id, i.name
      FROM implementation_dependency d
      JOIN implementation i ON i.implementation_id = d.consumer_id
      WHERE d.provider_id = :id
      ORDER BY i.name, d.consumer_id`),
  );

  private readonly platformsByImplementation = computed(() => {
    const grouped = new Map<string, { platform_id: string; label: string }[]>();
    for (const row of this.implementationPlatforms.value()) {
      const bucket = grouped.get(row.implementation_id);
      const entry = { platform_id: row.platform_id, label: row.label };
      if (bucket === undefined) {
        grouped.set(row.implementation_id, [entry]);
      } else {
        bucket.push(entry);
      }
    }
    return grouped;
  });

  protected platformsFor(id: string): readonly { platform_id: string; label: string }[] {
    return this.platformsByImplementation().get(id) ?? [];
  }

  protected readonly licensesInPlay = computed(() =>
    [
      ...new Set(
        this.implementations
          .value()
          .map((row) => row.license_id)
          .filter((id) => id !== null),
      ),
    ].sort((a, b) => a.localeCompare(b)),
  );

  protected readonly projectsInPlay = computed(() => {
    const names = new Map<string, string>();
    for (const row of this.implementations.value()) {
      if (row.project_id !== null) {
        const label =
          row.author === null ? row.project_name : `${row.project_name} — ${row.author}`;
        names.set(row.project_id, label ?? row.project_id);
      }
    }
    return [...names]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  protected readonly rows = computed(() => {
    const term = this.q();
    const language = this.language().trim();
    const license = this.license().trim();
    const accuracy = this.accuracy().trim();
    const project = this.project().trim();
    const platform = this.platform().trim();
    const platforms = this.platformsByImplementation();

    return this.implementations.value().filter((row) => {
      if (language !== '' && row.hdl_language_id !== language) {
        return false;
      }
      if (!matchesNullable(row.license_id, license)) {
        return false;
      }
      if (!matchesNullable(row.accuracy_id, accuracy)) {
        return false;
      }
      if (project !== '' && row.project_id !== project) {
        return false;
      }
      if (
        platform !== '' &&
        !(platforms.get(row.implementation_id) ?? []).some(
          (entry) => entry.platform_id === platform,
        )
      ) {
        return false;
      }
      return matchesText(term, row.name, row.implementation_id, row.author, row.project_name);
    });
  });

  protected readonly withLicense = computed(
    () => this.implementations.value().filter((row) => row.license_id !== null).length,
  );

  protected readonly withAccuracy = computed(
    () => this.implementations.value().filter((row) => row.accuracy_id !== null).length,
  );

  private readonly pages = signal(1);

  /**
   * The expanded row is pulled to the front of the page window, so a link from search
   * lands on a visible row rather than one 300 rows below the fold.
   */
  protected readonly visibleRows = computed(() => {
    const open = this.implementation().trim();
    const window = this.rows().slice(0, this.pages() * PAGE_SIZE);
    if (open === '' || window.some((row) => row.implementation_id === open)) {
      return window;
    }
    const target = this.rows().find((row) => row.implementation_id === open);
    return target === undefined ? window : [target, ...window];
  });

  protected isOpen(id: string): boolean {
    return this.implementation() === id;
  }

  protected toggle(id: string): void {
    this.write({ implementation: this.isOpen(id) ? null : id });
  }

  protected setParam(key: string, event: Event): void {
    this.write({ [key]: paramValue(controlValue(event)) });
  }

  protected reset(): void {
    this.write({
      q: null,
      language: null,
      license: null,
      accuracy: null,
      project: null,
      platform: null,
      implementation: null,
    });
  }

  protected showMore(): void {
    this.pages.update((count) => count + 1);
  }
}

/**
 * `''` matches anything; `none` matches only an absent value; anything else is an
 * equality test. The `none` option is the point — "no licence recorded" is a real,
 * actionable filter on a catalogue whose whole job is to say what has been checked.
 */
function matchesNullable(value: string | null, filter: string): boolean {
  if (filter === '') {
    return true;
  }
  return filter === 'none' ? value === null : value === filter;
}
