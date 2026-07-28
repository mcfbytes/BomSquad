import { Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import { DataStatus } from '../data/data-status';
import { DatabaseService } from '../data/database';
import { isPending, query, queryRow } from '../data/query';
import { CoverageBadge } from '../shared/coverage-badge';
import { UNKNOWN, formatCount, formatHz, mameDriverUrl, pluralize } from '../shared/format';

interface MachineHead {
  readonly machine_id: string;
  readonly name: string;
  readonly year: number | null;
  readonly manufacturer_name: string | null;
  readonly system_id: string | null;
  readonly system_name: string | null;
  readonly mame_sourcefile: string;
  readonly driver_status: string | null;
  readonly clone_count: number | null;
  readonly correction_reason: string | null;
  readonly correction_source: string | null;
  readonly system_reason: string | null;
}

interface BomRow {
  readonly chip_id: string;
  readonly role: string;
  readonly quantity: number;
  readonly clock_hz: number | null;
  /** `machine` — a MAME socket — or `system` — inherited from the family's chipset. */
  readonly via: string;
  readonly display_name: string;
  readonly function_label: string;
  readonly prospector_band: string;
  readonly best_via: string | null;
  readonly provider_chip_id: string | null;
}

interface BomImplementation {
  readonly chip_id: string;
  readonly implementation_id: string;
  readonly name: string;
  readonly repo_url: string | null;
  readonly via: string;
}

interface MachineCore {
  readonly implementation_id: string;
  readonly name: string;
  readonly repo_url: string | null;
  readonly license_id: string | null;
  readonly accuracy_id: string | null;
  /** `machine` when the core names this set, `system` when it claims the whole family. */
  readonly scope: string;
}

const MACHINE_HEAD_SQL = `
SELECT m.machine_id, m.name, m.year, mf.name AS manufacturer_name,
       m.system_id, s.name AS system_name, m.mame_sourcefile, m.driver_status, m.clone_count,
       mc.reason AS correction_reason, mc.source_url AS correction_source,
       msy.reason AS system_reason
FROM v_machine m
LEFT JOIN manufacturer mf       ON mf.manufacturer_id = m.manufacturer_id
LEFT JOIN system s              ON s.system_id = m.system_id
LEFT JOIN machine_correction mc ON mc.machine_id = m.machine_id
LEFT JOIN machine_system msy    ON msy.machine_id = m.machine_id
WHERE m.machine_id = :id`;

const BOM_SQL = `
SELECT b.chip_id, b.role, b.quantity, b.clock_hz, b.via,
       c.display_name, cf.label AS function_label, cf.prospector_band,
       e.best_via, e.provider_chip_id
FROM v_machine_bom b
JOIN chip c           ON c.chip_id = b.chip_id
JOIN chip_function cf ON cf.function_id = c.function_id
LEFT JOIN v_chip_evidence e ON e.kind_id = 'fpga_hdl' AND e.chip_id = b.chip_id
WHERE b.machine_id = :id
ORDER BY b.role, b.chip_id`;

/** Every FPGA implementation that satisfies any socket in this BOM, direct or by edge. */
const BOM_IMPLEMENTATIONS_SQL = `
SELECT s.socket_chip_id AS chip_id, i.implementation_id, i.name, i.repo_url, s.via
FROM v_chip_satisfies s
JOIN implementation_chip ic ON ic.chip_id = s.provider_chip_id
JOIN implementation i       ON i.implementation_id = ic.implementation_id
WHERE i.kind_id = 'fpga_hdl'
  AND s.socket_chip_id IN (SELECT chip_id FROM v_machine_bom WHERE machine_id = :id)
ORDER BY s.socket_chip_id, i.name, i.implementation_id`;

const CORES_SQL = `
SELECT DISTINCT i.implementation_id, i.name, i.repo_url, i.license_id, i.accuracy_id,
       CASE WHEN im.machine_id IS NOT NULL THEN 'machine' ELSE 'system' END AS scope
FROM implementation i
LEFT JOIN implementation_machine im
       ON im.implementation_id = i.implementation_id AND im.machine_id = :id
LEFT JOIN implementation_system isy
       ON isy.implementation_id = i.implementation_id
      AND isy.system_id = (SELECT system_id FROM v_machine_system WHERE machine_id = :id)
WHERE im.machine_id IS NOT NULL OR isy.system_id IS NOT NULL
ORDER BY i.name, i.implementation_id`;

/**
 * Machine detail (PLAN §5 view 5, TASKS T7.5), permalink `/machine/:machineId`.
 *
 * The BOM table is the page. It stays deliberately plain — body sans, no pixel face, no
 * shadows, one badge per row — because T7.12's acceptance bar is that a 40-row bill of
 * materials never pays for the theme.
 *
 * Two things the table says out loud that a naive coverage figure would swallow:
 *
 * - **where each socket came from.** `v_machine_bom` unions MAME's per-machine devices
 *   with the platform family's curated chipset, and a socket inherited from the family
 *   is a weaker claim about *this* board than one MAME lists for it. The `Source`
 *   column says which.
 * - **what is not in the BOM at all.** Every MAME device that has not been mapped to a
 *   chip yet is listed under the table with its quantity, and the coverage badge is
 *   captioned with how many there are. Without that, a 3/3 board with six uncatalogued
 *   customs reads as finished.
 */
@Component({
  selector: 'app-machine-detail',
  imports: [RouterLink, CoverageBadge, DataStatus],
  template: `
    <app-data-status
      [loading]="pending()"
      [error]="head.error()"
      loadingLabel="Loading the machine…"
      (retry)="head.reload()"
    />

    @if (!pending() && head.error() === undefined) {
      @if (head.value(); as machine) {
        <header class="view__head">
          <p class="eyebrow">
            @if (machine.system_id; as system) {
              <a [routerLink]="['/system', system]">{{ machine.system_name }}</a>
            } @else {
              Unassigned to a platform family
            }
          </p>
          <h1>{{ machine.name }}</h1>
          <p class="view__id">
            <code>{{ machine.machine_id }}</code> · {{ machine.manufacturer_name ?? unknown }} ·
            {{ machine.year ?? unknown }}
          </p>
        </header>

        <div class="columns">
          <section class="section" aria-labelledby="facts-heading">
            <h2 id="facts-heading">MAME</h2>
            <dl class="meta">
              <dt>Driver</dt>
              <dd>
                <a [href]="driverUrl(machine.mame_sourcefile)" rel="noopener nofollow"
                  ><code>{{ machine.mame_sourcefile }}</code></a
                >
                @if (mameVersion(); as version) {
                  <span class="tag tag--muted">MAME {{ version }}</span>
                }
              </dd>
              <dt>Driver status</dt>
              <dd>
                @if (machine.driver_status; as status) {
                  <span
                    class="tag"
                    [class.tag--ok]="status === 'good'"
                    [class.tag--warn]="status === 'imperfect'"
                    [class.tag--bad]="status === 'preliminary'"
                    >{{ status }}</span
                  >
                } @else {
                  {{ unknown }}
                }
              </dd>
              <dt>Clones folded away</dt>
              <dd>{{ machine.clone_count ?? 0 }}</dd>
              @if (machine.correction_reason; as reason) {
                <dt>Curated correction</dt>
                <dd>
                  {{ reason }}
                  @if (machine.correction_source; as url) {
                    <a [href]="url" rel="noopener nofollow">source</a>
                  }
                </dd>
              }
              @if (machine.system_reason; as reason) {
                <dt>Family assignment</dt>
                <dd>{{ reason }}</dd>
              }
            </dl>
          </section>

          <section class="section" aria-labelledby="cores-heading">
            <h2 id="cores-heading">Existing cores</h2>
            @if (cores.value().length === 0) {
              <p class="empty">
                No FPGA core in the catalogue targets this machine or its platform family — which is
                what makes its family a Prospector candidate.
                @if (machine.system_id) {
                  <a routerLink="/prospector" [queryParams]="{ q: machine.system_id }"
                    >See it in the Prospector</a
                  >.
                }
              </p>
            } @else {
              <ul class="plain-list">
                @for (core of cores.value(); track core.implementation_id) {
                  <li class="core">
                    @if (core.repo_url; as url) {
                      <a [href]="url" rel="noopener nofollow">{{ core.name }}</a>
                    } @else {
                      {{ core.name }}
                    }
                    <span class="tag">{{
                      core.scope === 'machine' ? 'names this machine' : 'covers the family'
                    }}</span>
                    @if (core.license_id; as license) {
                      <span class="tag tag--muted">{{ license }}</span>
                    }
                    @if (core.accuracy_id; as accuracy) {
                      <span class="tag tag--muted">{{ accuracy }}</span>
                    }
                  </li>
                }
              </ul>
            }
          </section>
        </div>

        <section class="section" aria-labelledby="bom-heading">
          <div class="section__head">
            <h2 id="bom-heading">Bill of materials</h2>
            <app-coverage-badge [covered]="satisfiedCount()" [total]="bom.value().length" />
          </div>

          @if (unmapped.value().length > 0) {
            <p class="caveat">
              {{ pluralize(unmapped.value().length, 'MAME device') }} on this machine
              {{ unmapped.value().length === 1 ? 'is' : 'are' }} not mapped to a catalogued chip
              yet, so they are missing from the table below and from the badge above. The badge
              describes the {{ bom.value().length }} sockets that <em>are</em> catalogued, not the
              whole board.
            </p>
          }

          @if (bom.value().length === 0) {
            <p class="empty">
              Nothing in this machine has been mapped to a catalogued chip yet.
              @if (unmapped.value().length > 0) {
                All {{ unmapped.value().length }} of its MAME devices are on the mapping worklist.
              }
            </p>
          } @else {
            <div class="table-scroll">
              <table>
                <caption>
                  One row per socket. A row is covered when some
                  <code>fpga_hdl</code>
                  implementation names the part, or names a part a curated equivalence says can
                  stand in.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Socket</th>
                    <th scope="col">Chip</th>
                    <th scope="col">Function</th>
                    <th scope="col">Clock</th>
                    <th scope="col" class="num">Qty</th>
                    <th scope="col">Source</th>
                    <th scope="col">Implementation</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of bom.value(); track row.role + '/' + row.chip_id) {
                    <tr>
                      <th scope="row">
                        <code>{{ row.role }}</code>
                      </th>
                      <td>
                        <a [routerLink]="['/chip', row.chip_id]">{{ row.display_name }}</a>
                      </td>
                      <td>
                        {{ row.function_label }}
                        <span
                          class="tag"
                          [class.tag--bad]="row.prospector_band === 'hard'"
                          [class.tag--warn]="row.prospector_band === 'medium'"
                          [class.tag--muted]="row.prospector_band === 'soft'"
                          >{{ row.prospector_band }}</span
                        >
                      </td>
                      <td class="nowrap">{{ formatHz(row.clock_hz) }}</td>
                      <td class="num">{{ row.quantity }}</td>
                      <td>
                        @if (row.via === 'system' && machine.system_id) {
                          <a [routerLink]="['/system', machine.system_id]">chipset</a>
                        } @else {
                          MAME
                        }
                      </td>
                      <td>
                        @if (row.best_via === null) {
                          <span class="tag tag--bad">missing</span>
                        } @else {
                          @for (
                            impl of implementationsFor(row.chip_id);
                            track impl.implementation_id
                          ) {
                            @if (impl.repo_url; as url) {
                              <a class="impl" [href]="url" rel="noopener nofollow">{{
                                impl.name
                              }}</a>
                            } @else {
                              <span class="impl">{{ impl.name }}</span>
                            }
                          }
                          @if (row.best_via !== 'self') {
                            <span class="tag tag--warn"
                              >via {{ row.best_via }} {{ row.provider_chip_id }}</span
                            >
                          }
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>

        <section class="section" aria-labelledby="unmapped-heading">
          <h2 id="unmapped-heading">Uncatalogued MAME devices</h2>
          @if (unmapped.value().length === 0) {
            <p class="empty">
              Every MAME device on this machine is mapped to a catalogued chip. Its coverage figure
              is about the whole board.
            </p>
          } @else {
            <p class="result-count">
              These are the devices MAME lists that no <code>mame_device</code> row maps to a chip
              yet. Each one is a
              <a
                href="https://github.com/mcfbytes/BomSquad/blob/master/CONTRIBUTING.md"
                rel="noopener"
                >mapping contribution</a
              >
              waiting to happen.
            </p>
            <ul class="tag-row plain-list">
              @for (device of unmapped.value(); track device.mame_device) {
                <li>
                  <span class="tag tag--muted"
                    >{{ device.mame_device }}
                    @if (device.quantity > 1) {
                      × {{ device.quantity }}
                    }
                  </span>
                </li>
              }
            </ul>
          }
        </section>
      } @else {
        <header class="view__head">
          <h1>No such machine</h1>
          <p class="view__lede">
            Nothing in the dataset has the MAME short name <code>{{ machineId() }}</code
            >. The extraction keeps parent sets only, so a clone's short name will not resolve here.
          </p>
          <p><a class="pixel-button" routerLink="/machines">Browse machines</a></p>
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

    .caveat {
      margin: 0 0 1rem;
      padding-left: 0.6rem;
      border-left: var(--border-w-thin) solid var(--warn);
      font-size: 0.9375rem;
    }

    .core + .core {
      margin-top: 0.5rem;
    }

    .impl + .impl::before {
      content: ', ';
      color: var(--muted);
    }
  `,
})
export class MachineDetail {
  private readonly database = inject(DatabaseService);

  readonly machineId = input.required<string>();

  protected readonly unknown = UNKNOWN;
  protected readonly formatHz = formatHz;
  protected readonly formatCount = formatCount;
  protected readonly pluralize = pluralize;

  private spec(sql: string) {
    return () => ({ sql, params: { ':id': this.machineId() } });
  }

  protected readonly head = queryRow<MachineHead>(this.spec(MACHINE_HEAD_SQL));
  protected readonly bom = query<BomRow>(this.spec(BOM_SQL));
  protected readonly cores = query<MachineCore>(this.spec(CORES_SQL));

  protected readonly unmapped = query<{
    readonly mame_device: string;
    readonly quantity: number;
  }>(
    this.spec(
      'SELECT mame_device, quantity FROM machine_unmapped_device WHERE machine_id = :id ORDER BY mame_device',
    ),
  );

  private readonly bomImplementations = query<BomImplementation>(
    this.spec(BOM_IMPLEMENTATIONS_SQL),
  );

  private readonly mameVersionRow = queryRow<{ readonly value: string }>(() => ({
    sql: "SELECT value FROM dataset_meta WHERE key = 'mame_version'",
  }));

  protected readonly mameVersion = computed(() => this.mameVersionRow.value()?.value ?? null);

  protected readonly pending = computed(() => isPending(this.head)() || this.database.isLoading());

  protected readonly satisfiedCount = computed(
    () => this.bom.value().filter((row) => row.best_via !== null).length,
  );

  private readonly implementationsByChip = computed(() => {
    const grouped = new Map<string, BomImplementation[]>();
    for (const row of this.bomImplementations.value()) {
      const bucket = grouped.get(row.chip_id);
      if (bucket === undefined) {
        grouped.set(row.chip_id, [row]);
      } else {
        bucket.push(row);
      }
    }
    return grouped;
  });

  protected implementationsFor(chipId: string): readonly BomImplementation[] {
    return this.implementationsByChip().get(chipId) ?? [];
  }

  protected driverUrl(sourcefile: string): string {
    return mameDriverUrl(sourcefile, this.mameVersion());
  }
}
