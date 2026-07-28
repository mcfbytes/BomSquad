import { Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import { DataStatus } from '../data/data-status';
import { DatabaseService } from '../data/database';
import { isPending, query, queryRow } from '../data/query';
import { UNKNOWN, formatCount, formatHz, pluralize } from '../shared/format';

/** Machines listed inline before the browser takes over. `z80` is in 3 376 of them. */
const MACHINE_SAMPLE = 40;

interface ChipHead {
  readonly chip_id: string;
  readonly display_name: string;
  readonly function_id: string;
  readonly function_label: string;
  readonly function_description: string;
  readonly prospector_band: string;
  readonly manufacturer_id: string | null;
  readonly manufacturer_name: string | null;
  readonly family_id: string | null;
  readonly family_name: string | null;
  readonly model: string | null;
  readonly description: string | null;
  readonly typical_clock_hz: number | null;
  readonly package: string | null;
  readonly year_introduced: number | null;
  readonly notes: string | null;
}

interface ChipImplementation {
  readonly implementation_id: string;
  readonly name: string;
  readonly kind_id: string;
  readonly repo_url: string | null;
  readonly license_id: string | null;
  readonly license_name: string | null;
  readonly accuracy_id: string | null;
  readonly accuracy_label: string | null;
  readonly language_label: string | null;
  readonly project_id: string | null;
  readonly project_name: string | null;
  readonly author: string | null;
  readonly verified_against_hardware: number | null;
  readonly last_reviewed: string | null;
  readonly via: string;
  readonly provider_chip_id: string;
}

interface ChipMachine {
  readonly machine_id: string;
  readonly name: string;
  readonly year: number | null;
  readonly system_id: string | null;
  readonly role: string;
  readonly via: string;
  readonly clock_hz: number | null;
  readonly quantity: number;
}

interface ChipEquivalence {
  readonly from_chip_id: string;
  readonly to_chip_id: string;
  readonly kind: string;
  readonly note: string;
  readonly from_name: string;
  readonly to_name: string;
}

/**
 * The head row, resolved through `chip_name` as well as through `chip_id`.
 *
 * TASKS.md standing rule 5 keeps retired identifiers and aliases resolving rather than
 * 404ing, and `chip_name` carries both kinds. Matching is case-insensitive because
 * aliases are written as the part is *marketed* (`OPM`, `Z-80`) while permalinks are
 * slugs — so `/chip/OPM` has to find `ym2151` or the alias mechanism only works for
 * people who already know the answer.
 *
 * The `ORDER BY` keeps the resolution total and deterministic: an exact `chip_id` beats
 * a case-folded one, which beats an alias. A permalink can never be captured by
 * somebody else's alias.
 */
const CHIP_HEAD_SQL = `
SELECT c.chip_id, c.display_name, c.function_id, cf.label AS function_label,
       cf.description AS function_description, cf.prospector_band,
       c.manufacturer_id, mf.name AS manufacturer_name,
       c.family_id, fam.name AS family_name,
       c.model, c.description, c.typical_clock_hz, c.package, c.year_introduced, c.notes
FROM chip c
JOIN chip_function cf     ON cf.function_id = c.function_id
LEFT JOIN manufacturer mf ON mf.manufacturer_id = c.manufacturer_id
LEFT JOIN chip_family fam ON fam.family_id = c.family_id
WHERE lower(c.chip_id) = lower(:id)
   OR c.chip_id IN (SELECT chip_id FROM chip_name WHERE lower(name) = lower(:id))
ORDER BY CASE WHEN c.chip_id = :id THEN 0
              WHEN lower(c.chip_id) = lower(:id) THEN 1
              ELSE 2 END,
         c.chip_id
LIMIT 1`;

/**
 * Every implementation that satisfies this socket, including the ones that reach it
 * through a curated equivalence — which is exactly what `v_chip_satisfies` is for. The
 * route comes back as a column so the page can say *how* each one qualifies rather than
 * presenting a `provides` edge as if it were a direct implementation.
 */
const CHIP_IMPLEMENTATIONS_SQL = `
SELECT DISTINCT i.implementation_id, i.name, i.kind_id, i.repo_url,
       i.license_id, l.name AS license_name,
       i.accuracy_id, a.label AS accuracy_label,
       hl.label AS language_label,
       i.project_id, pr.name AS project_name, pr.author,
       i.verified_against_hardware, i.last_reviewed,
       s.via, s.provider_chip_id
FROM v_chip_satisfies s
JOIN implementation_chip ic ON ic.chip_id = s.provider_chip_id
JOIN implementation i       ON i.implementation_id = ic.implementation_id
LEFT JOIN license l         ON l.license_id = i.license_id
LEFT JOIN accuracy_level a  ON a.accuracy_id = i.accuracy_id
LEFT JOIN hdl_language hl   ON hl.language_id = i.hdl_language_id
LEFT JOIN project pr        ON pr.project_id = i.project_id
WHERE s.socket_chip_id = :id
ORDER BY CASE s.via WHEN 'self' THEN 0 WHEN 'equivalent' THEN 1 ELSE 2 END,
         i.name, i.implementation_id`;

const CHIP_MACHINES_SQL = `
SELECT b.machine_id, m.name, m.year, m.system_id, b.role, b.via, b.clock_hz, b.quantity
FROM v_machine_bom b
JOIN v_machine m ON m.machine_id = b.machine_id
WHERE b.chip_id = :id
ORDER BY m.name, b.machine_id
LIMIT :limit`;

const CHIP_EQUIVALENCE_SQL = `
SELECT e.from_chip_id, e.to_chip_id, e.kind, e.note,
       f.display_name AS from_name, t.display_name AS to_name
FROM chip_equivalence e
JOIN chip f ON f.chip_id = e.from_chip_id
JOIN chip t ON t.chip_id = e.to_chip_id
WHERE e.from_chip_id = :id OR e.to_chip_id = :id
ORDER BY e.from_chip_id, e.to_chip_id`;

/**
 * Chip detail (PLAN §5 view 3, TASKS T7.4), permalink `/chip/:chipId`.
 *
 * Nine statements against the shipped views, all of them idle until the route parameter
 * resolves. The head query resolves aliases and retired ids, so an old permalink lands
 * on the part rather than on a "not found".
 */
@Component({
  selector: 'app-chip-detail',
  imports: [RouterLink, DataStatus],
  template: `
    <app-data-status
      [loading]="pending()"
      [error]="head.error()"
      loadingLabel="Loading the chip…"
      (retry)="head.reload()"
    />

    @if (!pending() && head.error() === undefined) {
      @if (head.value(); as chip) {
        <header class="view__head">
          <p class="eyebrow">{{ chip.function_label }}</p>
          <h1>{{ chip.display_name }}</h1>
          <p class="view__id">
            <code>{{ chip.chip_id }}</code>
            @if (chip.chip_id !== chipId()) {
              — you followed <code>{{ chipId() }}</code
              >, which this part is also known by.
            }
          </p>
          @if (chip.description; as description) {
            <p class="view__lede">{{ description }}</p>
          }
        </header>

        <div class="columns">
          <section class="section" aria-labelledby="specs-heading">
            <h2 id="specs-heading">Specifications</h2>
            <dl class="meta">
              <dt>Function</dt>
              <dd>
                {{ chip.function_label }}
                <span
                  class="tag"
                  [class.tag--bad]="chip.prospector_band === 'hard'"
                  [class.tag--warn]="chip.prospector_band === 'medium'"
                  [class.tag--muted]="chip.prospector_band === 'soft'"
                  >{{ chip.prospector_band }} band</span
                >
              </dd>
              <dt>Manufacturer</dt>
              <dd>{{ chip.manufacturer_name ?? unknown }}</dd>
              <dt>Family</dt>
              <dd>{{ chip.family_name ?? unknown }}</dd>
              <dt>Model</dt>
              <dd>{{ chip.model ?? unknown }}</dd>
              <dt>Package</dt>
              <dd>{{ chip.package ?? unknown }}</dd>
              <dt>Typical clock</dt>
              <dd>{{ formatHz(chip.typical_clock_hz) }}</dd>
              <dt>Introduced</dt>
              <dd>{{ chip.year_introduced ?? unknown }}</dd>
              <dt>Also known as</dt>
              <dd>
                @if (names.value().length === 0) {
                  {{ unknown }}
                } @else {
                  @for (alias of names.value(); track alias.name) {
                    <span class="tag tag--muted"
                      >{{ alias.name }}<span class="sr-only"> ({{ alias.kind }})</span></span
                    >
                  }
                }
              </dd>
              <dt>MAME devices</dt>
              <dd>
                @if (devices.value().length === 0) {
                  Nothing in <code>mame_device</code> maps to this part yet.
                } @else {
                  @for (device of devices.value(); track device.mame_device) {
                    <code class="device">{{ device.mame_device }}</code>
                  }
                }
              </dd>
            </dl>

            @if (chip.notes; as notes) {
              <p class="note">{{ notes }}</p>
            }

            @if (datasheets.value().length > 0) {
              <h3>Datasheets</h3>
              <ul class="plain-list">
                @for (sheet of datasheets.value(); track sheet.url) {
                  <li>
                    <a [href]="sheet.url" rel="noopener nofollow">{{ sheet.title ?? sheet.url }}</a>
                  </li>
                }
              </ul>
            }
          </section>

          <section class="section" aria-labelledby="equivalence-heading">
            <h2 id="equivalence-heading">Equivalences</h2>
            @if (equivalences.value().length === 0) {
              <p class="empty">
                No curated substitution claim touches this part. Coverage for it has to come from an
                implementation naming it outright.
              </p>
            } @else {
              <ul class="plain-list">
                @for (edge of equivalences.value(); track edge.from_chip_id + edge.to_chip_id) {
                  <li class="equivalence">
                    <p class="equivalence__claim">
                      <a [routerLink]="['/chip', edge.from_chip_id]">{{ edge.from_name }}</a>
                      <span class="tag">{{
                        edge.kind === 'equivalent' ? 'is equivalent to' : 'provides'
                      }}</span>
                      <a [routerLink]="['/chip', edge.to_chip_id]">{{ edge.to_name }}</a>
                    </p>
                    <p class="equivalence__note">{{ edge.note }}</p>
                  </li>
                }
              </ul>
            }
          </section>
        </div>

        <section class="section" aria-labelledby="implementations-heading">
          <h2 id="implementations-heading">Implementations</h2>
          @if (implementations.value().length === 0) {
            <p class="empty">
              Nothing in the catalogue implements this part, and no equivalence reaches it. That is
              what puts it on the <a routerLink="/prospector">Prospector's</a> missing lists.
            </p>
          } @else {
            <div class="table-scroll">
              <table>
                <caption>
                  {{
                    pluralize(implementations.value().length, 'implementation')
                  }}. A route other than
                  <code>self</code>
                  means the implementation names a different part that a curated equivalence says
                  can stand in.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Implementation</th>
                    <th scope="col">Route</th>
                    <th scope="col">Language</th>
                    <th scope="col">License</th>
                    <th scope="col">Accuracy</th>
                    <th scope="col">Author</th>
                    <th scope="col">Reviewed</th>
                  </tr>
                </thead>
                <tbody>
                  @for (impl of implementations.value(); track impl.implementation_id) {
                    <tr>
                      <th scope="row">
                        @if (impl.repo_url; as url) {
                          <a [href]="url" rel="noopener nofollow">{{ impl.name }}</a>
                        } @else {
                          {{ impl.name }}
                        }
                        <br />
                        <a
                          class="subtle"
                          routerLink="/implementations"
                          [queryParams]="{ implementation: impl.implementation_id }"
                          >{{ impl.implementation_id }}</a
                        >
                      </th>
                      <td>
                        @if (impl.via === 'self') {
                          <span class="tag tag--ok">direct</span>
                        } @else {
                          <span class="tag tag--warn">{{ impl.via }}</span>
                          <a [routerLink]="['/chip', impl.provider_chip_id]">{{
                            impl.provider_chip_id
                          }}</a>
                        }
                      </td>
                      <td>{{ impl.language_label ?? unknown }}</td>
                      <td>
                        @if (impl.license_id; as license) {
                          <span class="tag" [title]="impl.license_name ?? license">{{
                            license
                          }}</span>
                        } @else {
                          <span class="tag tag--bad">unverified</span>
                        }
                      </td>
                      <td>
                        @if (impl.accuracy_label; as accuracy) {
                          <span class="tag">{{ accuracy }}</span>
                        } @else {
                          <span class="tag tag--bad">unassessed</span>
                        }
                        @if (impl.verified_against_hardware === 1) {
                          <span class="tag tag--ok">hardware-verified</span>
                        }
                      </td>
                      <td>{{ impl.author ?? impl.project_name ?? unknown }}</td>
                      <td class="nowrap">{{ impl.last_reviewed ?? unknown }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>

        <section class="section" aria-labelledby="systems-heading">
          <h2 id="systems-heading">Systems</h2>
          @if (systems.value().length === 0) {
            <p class="empty">No catalogued platform family lists this part in its chipset.</p>
          } @else {
            <p class="result-count">
              {{ pluralize(systems.value().length, 'platform family') }} carry this part.
            </p>
            <ul class="tag-row plain-list">
              @for (system of systems.value(); track system.system_id) {
                <li>
                  <a class="chip-link" [routerLink]="['/system', system.system_id]">{{
                    system.name
                  }}</a>
                </li>
              }
            </ul>
          }
        </section>

        <section class="section" aria-labelledby="machines-heading">
          <h2 id="machines-heading">Machines</h2>
          @if (machineCount.value(); as counted) {
            <p class="result-count">
              <strong>{{ formatCount(counted.machine_count) }}</strong> machines carry this part.
              @if (counted.machine_count > machines.value().length) {
                The first {{ machines.value().length }} are listed here — the
                <a routerLink="/machines">machine browser</a> has all of them.
              }
            </p>
          }
          @if (machines.value().length === 0) {
            <p class="empty">No machine in the dataset lists this part.</p>
          } @else {
            <div class="table-scroll">
              <table>
                <caption>
                  Sockets come from MAME per machine, or from the platform family's curated chipset.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Machine</th>
                    <th scope="col">Year</th>
                    <th scope="col">Socket</th>
                    <th scope="col">Clock</th>
                    <th scope="col" class="num">Qty</th>
                    <th scope="col">Via</th>
                  </tr>
                </thead>
                <tbody>
                  @for (machine of machines.value(); track machine.machine_id + machine.role) {
                    <tr>
                      <th scope="row">
                        <a [routerLink]="['/machine', machine.machine_id]">{{ machine.name }}</a>
                      </th>
                      <td class="num">{{ machine.year ?? unknown }}</td>
                      <td>
                        <code>{{ machine.role }}</code>
                      </td>
                      <td class="nowrap">{{ formatHz(machine.clock_hz) }}</td>
                      <td class="num">{{ machine.quantity }}</td>
                      <td>
                        @if (machine.via === 'system' && machine.system_id) {
                          <a [routerLink]="['/system', machine.system_id]">chipset</a>
                        } @else {
                          MAME
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>
      } @else {
        <header class="view__head">
          <h1>No such chip</h1>
          <p class="view__lede">
            Nothing in the catalogue is called <code>{{ chipId() }}</code
            >, and no alias or retired identifier resolves to it either.
          </p>
          <p><a class="pixel-button" routerLink="/chips">Browse the chip catalogue</a></p>
        </header>
      }
    }
  `,
  styles: `
    :host {
      display: block;
    }

    .columns {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr));
      gap: 2rem;
      margin-bottom: 2.5rem;
    }

    .columns .section {
      margin-bottom: 0;
    }

    .device,
    .meta .tag {
      margin-right: 0.3rem;
    }

    .equivalence + .equivalence {
      margin-top: 0.9rem;
    }

    .equivalence__claim {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.35rem;
      margin: 0;
    }

    .equivalence__note {
      margin: 0.2rem 0 0;
      color: var(--muted);
      font-size: 0.875rem;
    }

    .chip-link {
      display: inline-block;
      padding: 0.15rem 0.4rem;
      border: 1px solid var(--border);
      color: var(--fg);
      text-decoration: none;
    }

    .chip-link:hover {
      border-color: var(--border-strong);
      text-decoration: underline;
    }

    .subtle {
      font-size: 0.8125rem;
      color: var(--muted);
    }
  `,
})
export class ChipDetail {
  private readonly database = inject(DatabaseService);

  readonly chipId = input.required<string>();

  protected readonly unknown = UNKNOWN;
  protected readonly formatHz = formatHz;
  protected readonly formatCount = formatCount;
  protected readonly pluralize = pluralize;

  /** The resolved chip, which may differ from the requested id when that was an alias. */
  protected readonly head = queryRow<ChipHead>(() => ({
    sql: CHIP_HEAD_SQL,
    params: { ':id': this.chipId() },
  }));

  /** Everything below keys off the *resolved* id, so an alias route loads the real part. */
  private readonly resolvedId = computed(() => this.head.value()?.chip_id ?? null);

  private spec(sql: string, extra: Record<string, string | number> = {}) {
    return () => {
      const id = this.resolvedId();
      return id === null ? undefined : { sql, params: { ':id': id, ...extra } };
    };
  }

  protected readonly names = query<{ readonly name: string; readonly kind: string }>(
    this.spec('SELECT name, kind FROM chip_name WHERE chip_id = :id ORDER BY kind, name'),
  );

  protected readonly datasheets = query<{ readonly url: string; readonly title: string | null }>(
    this.spec('SELECT url, title FROM chip_datasheet WHERE chip_id = :id ORDER BY url'),
  );

  protected readonly devices = query<{ readonly mame_device: string }>(
    this.spec('SELECT mame_device FROM mame_device WHERE chip_id = :id ORDER BY mame_device'),
  );

  protected readonly implementations = query<ChipImplementation>(
    this.spec(CHIP_IMPLEMENTATIONS_SQL),
  );

  protected readonly equivalences = query<ChipEquivalence>(this.spec(CHIP_EQUIVALENCE_SQL));

  protected readonly systems = query<{
    readonly system_id: string;
    readonly name: string;
    readonly via: string;
  }>(
    this.spec(`
      SELECT sce.system_id, s.name, sce.via
      FROM v_system_chip_effective sce
      JOIN system s ON s.system_id = sce.system_id
      WHERE sce.chip_id = :id
      ORDER BY s.name, sce.system_id`),
  );

  protected readonly machines = query<ChipMachine>(
    this.spec(CHIP_MACHINES_SQL, { ':limit': MACHINE_SAMPLE }),
  );

  protected readonly machineCount = queryRow<{ readonly machine_count: number }>(
    this.spec(
      'SELECT COUNT(DISTINCT machine_id) AS machine_count FROM v_machine_bom WHERE chip_id = :id',
    ),
  );

  protected readonly pending = computed(() => isPending(this.head)() || this.database.isLoading());
}
