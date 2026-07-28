import { Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import { DataStatus } from '../data/data-status';
import { DatabaseService } from '../data/database';
import { isPending, query, queryRow } from '../data/query';
import { CoverageBadge } from '../shared/coverage-badge';
import { UNKNOWN, formatCount, formatShare, pluralize } from '../shared/format';

/** Member machines listed inline. Neo Geo MVS has hundreds. */
const MACHINE_SAMPLE = 60;

interface SystemHead {
  readonly system_id: string;
  readonly name: string;
  readonly kind_label: string;
  readonly manufacturer_name: string | null;
  readonly year_introduced: number | null;
  readonly description: string | null;
  readonly notes: string | null;
  readonly chips_total: number;
  readonly chips_satisfied: number;
  readonly chips_direct: number;
  readonly chips_equivalent: number;
  readonly chips_provided: number;
  readonly satisfied_share: number;
  readonly unmapped_device_count: number;
  readonly confidence: string | null;
  readonly machine_count: number;
  readonly unmapped_instance_share: number | null;
}

interface ChipsetRow {
  readonly chip_id: string;
  readonly via: string;
  readonly display_name: string;
  readonly function_label: string;
  readonly prospector_band: string;
  readonly satisfied_via: string | null;
  readonly provider_chip_id: string | null;
  readonly chip_confidence: string | null;
  readonly machine_count: number;
}

interface PlatformStatus {
  readonly platform_id: string;
  readonly label: string;
  readonly has_core: 0 | 1;
}

/**
 * The head query resolves `system_name` aliases as well as ids, case-insensitively, for
 * the same reason the chip page does: `CPS-1` is how the board is written on the PCB and
 * `capcom-cps1` is how the schema spells it, and a bookmark of either must not 404.
 */
const SYSTEM_HEAD_SQL = `
SELECT s.system_id, s.name, sk.label AS kind_label, mf.name AS manufacturer_name,
       s.year_introduced, s.description, s.notes,
       COALESCE(c.chips_total, 0)           AS chips_total,
       COALESCE(c.chips_satisfied, 0)       AS chips_satisfied,
       COALESCE(c.chips_direct, 0)          AS chips_direct,
       COALESCE(c.chips_equivalent, 0)      AS chips_equivalent,
       COALESCE(c.chips_provided, 0)        AS chips_provided,
       COALESCE(c.satisfied_share, 0.0)     AS satisfied_share,
       COALESCE(c.unmapped_device_count, 0) AS unmapped_device_count,
       c.confidence,
       (SELECT COUNT(*) FROM v_machine_system vms
         WHERE vms.system_id = s.system_id)  AS machine_count,
       (SELECT si.unmapped_share FROM v_system_instance si
         WHERE si.system_id = s.system_id)   AS unmapped_instance_share
FROM system s
JOIN system_kind sk       ON sk.kind_id = s.kind_id
LEFT JOIN manufacturer mf ON mf.manufacturer_id = s.manufacturer_id
LEFT JOIN v_system_coverage_by_kind c
       ON c.system_id = s.system_id AND c.kind_id = 'fpga_hdl'
WHERE lower(s.system_id) = lower(:id)
   OR s.system_id IN (SELECT system_id FROM system_name WHERE lower(name) = lower(:id))
ORDER BY CASE WHEN s.system_id = :id THEN 0
              WHEN lower(s.system_id) = lower(:id) THEN 1
              ELSE 2 END,
         s.system_id
LIMIT 1`;

/**
 * The shared chipset.
 *
 * `v_system_chip_effective` is the union of the curated `system_chip` rows and whatever
 * MAME attributes to the family's machines, and it labels which is which — a `curated`
 * row is somebody's researched claim about the board, a `mame` row is an observation.
 * The page shows the distinction rather than flattening it into one list.
 */
const CHIPSET_SQL = `
SELECT e.chip_id, e.via, c.display_name, cf.label AS function_label, cf.prospector_band,
       cc.satisfied_via, cc.provider_chip_id, cc.chip_confidence,
       (SELECT COUNT(DISTINCT mc.machine_id)
          FROM machine_chip mc
          JOIN v_machine_system vms ON vms.machine_id = mc.machine_id
         WHERE mc.chip_id = e.chip_id AND vms.system_id = e.system_id) AS machine_count
FROM v_system_chip_effective e
JOIN chip c           ON c.chip_id = e.chip_id
JOIN chip_function cf ON cf.function_id = c.function_id
LEFT JOIN v_system_chip_coverage cc
       ON cc.kind_id = 'fpga_hdl' AND cc.system_id = e.system_id AND cc.chip_id = e.chip_id
WHERE e.system_id = :id
ORDER BY CASE cf.prospector_band WHEN 'hard' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
         c.display_name, e.chip_id`;

const PLATFORM_STATUS_SQL = `
SELECT p.platform_id, p.label,
       CASE WHEN EXISTS (SELECT 1 FROM v_system_core f
                          WHERE f.kind_id = 'fpga_hdl'
                            AND f.system_id = :id
                            AND f.platform_id = p.platform_id)
            THEN 1 ELSE 0 END AS has_core
FROM fpga_platform p
ORDER BY p.label, p.platform_id`;

/**
 * Platform family view (PLAN §5 view 6, TASKS T7.6), permalink `/system/:systemId`.
 *
 * `/family/:systemId` redirects here — PLAN writes the permalink that way and the schema
 * calls the entity `system`, so both resolve and only one is canonical.
 */
@Component({
  selector: 'app-system-detail',
  imports: [RouterLink, CoverageBadge, DataStatus],
  template: `
    <app-data-status
      [loading]="pending()"
      [error]="head.error()"
      loadingLabel="Loading the platform family…"
      (retry)="head.reload()"
    />

    @if (!pending() && head.error() === undefined) {
      @if (head.value(); as system) {
        <header class="view__head">
          <p class="eyebrow">{{ system.kind_label }} platform family</p>
          <h1>{{ system.name }}</h1>
          <p class="view__id">
            <code>{{ system.system_id }}</code> · {{ system.manufacturer_name ?? unknown }} ·
            {{ system.year_introduced ?? unknown }}
            @if (system.system_id !== systemId()) {
              — you followed <code>{{ systemId() }}</code
              >, an older name for this family.
            }
          </p>
          @if (system.description; as description) {
            <p class="view__lede">{{ description }}</p>
          }
        </header>

        <section class="section" aria-labelledby="coverage-heading">
          <div class="section__head">
            <h2 id="coverage-heading">Family coverage</h2>
            <app-coverage-badge [covered]="system.chips_satisfied" [total]="system.chips_total" />
          </div>

          <dl class="meta">
            <dt>Satisfied share</dt>
            <dd>
              {{ formatShare(system.satisfied_share) }} of {{ system.chips_total }} catalogued
              sockets ({{ system.chips_direct }} direct, {{ system.chips_equivalent }} by
              equivalence, {{ system.chips_provided }} by a <em>provides</em> claim)
            </dd>
            <dt>Confidence</dt>
            <dd>
              @if (system.confidence; as confidence) {
                <span
                  class="tag"
                  [class.tag--ok]="confidence === 'high'"
                  [class.tag--warn]="confidence === 'medium'"
                  [class.tag--bad]="confidence === 'low'"
                  >{{ confidence }}</span
                >
              } @else {
                {{ unknown }}
              }
            </dd>
            <dt>Uncatalogued devices</dt>
            <dd>
              {{ system.unmapped_device_count }} distinct MAME devices across this family's machines
              are not mapped to a chip yet
              @if (system.unmapped_instance_share !== null) {
                — {{ formatShare(system.unmapped_instance_share) }} of every device instance on
                these boards
              }
            </dd>
            <dt>Machines</dt>
            <dd>{{ pluralize(system.machine_count, 'machine') }}</dd>
          </dl>

          @if (system.unmapped_device_count > 0) {
            <p class="caveat">
              The share above is computed over the sockets that are catalogued. It is not a claim
              about the whole board, and it is exactly the figure the
              <a routerLink="/prospector">Prospector</a> demotes for boards in this position.
            </p>
          }

          @if (system.notes; as notes) {
            <p class="note">{{ notes }}</p>
          }
        </section>

        <section class="section" aria-labelledby="platforms-heading">
          <h2 id="platforms-heading">Cores by target platform</h2>
          <ul class="tag-row plain-list">
            @for (platform of platforms.value(); track platform.platform_id) {
              <li>
                @if (platform.has_core === 1) {
                  <span class="tag tag--ok">{{ platform.label }}: core exists</span>
                } @else {
                  <a
                    class="tag"
                    routerLink="/prospector"
                    [queryParams]="{ platform: platform.platform_id, q: system.system_id }"
                    >{{ platform.label }}: no core — rank it</a
                  >
                }
              </li>
            }
          </ul>

          @if (cores.value().length > 0) {
            <h3>Implementations claiming this family</h3>
            <ul class="plain-list">
              @for (core of cores.value(); track core.implementation_id) {
                <li>
                  @if (core.repo_url; as url) {
                    <a [href]="url" rel="noopener nofollow">{{ core.name }}</a>
                  } @else {
                    {{ core.name }}
                  }
                  @if (core.license_id; as license) {
                    <span class="tag tag--muted">{{ license }}</span>
                  }
                </li>
              }
            </ul>
          }
        </section>

        <section class="section" aria-labelledby="chipset-heading">
          <h2 id="chipset-heading">Shared chipset</h2>
          @if (chipset.value().length === 0) {
            <p class="empty">
              No chip has been attributed to this family yet, by curation or by MAME.
            </p>
          } @else {
            <div class="table-scroll">
              <table>
                <caption>
                  <code>curated</code>
                  rows are researched claims about the board;
                  <code>mame</code>
                  rows are what MAME attributes to this family's machines.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Chip</th>
                    <th scope="col">Function</th>
                    <th scope="col">Source</th>
                    <th scope="col" class="num">Machines</th>
                    <th scope="col">FPGA coverage</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of chipset.value(); track row.chip_id) {
                    <tr>
                      <th scope="row">
                        <a [routerLink]="['/chip', row.chip_id]">{{ row.display_name }}</a>
                      </th>
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
                      <td>
                        <code>{{ row.via }}</code>
                      </td>
                      <td class="num">{{ formatCount(row.machine_count) }}</td>
                      <td>
                        @switch (row.satisfied_via) {
                          @case ('self') {
                            <span class="tag tag--ok">implemented</span>
                          }
                          @case ('unsatisfied') {
                            <span class="tag tag--bad">missing</span>
                          }
                          @case (null) {
                            <span class="tag tag--bad">missing</span>
                          }
                          @default {
                            <span class="tag tag--warn">via {{ row.satisfied_via }}</span>
                            <a [routerLink]="['/chip', row.provider_chip_id]">{{
                              row.provider_chip_id
                            }}</a>
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

        <section class="section" aria-labelledby="members-heading">
          <h2 id="members-heading">Member machines</h2>
          @if (machines.value().length === 0) {
            <p class="empty">No machine is assigned to this family.</p>
          } @else {
            <p class="result-count">
              <strong>{{ formatCount(system.machine_count) }}</strong> machines.
              @if (system.machine_count > machines.value().length) {
                The first {{ machines.value().length }} are listed here; the
                <a routerLink="/machines" [queryParams]="{ family: system.system_id }"
                  >machine browser</a
                >
                has the rest.
              }
              Membership comes from a per-machine assignment where one exists, and otherwise from
              the driver rules below.
            </p>
            <ul class="tag-row plain-list">
              @for (machine of machines.value(); track machine.machine_id) {
                <li>
                  <a class="machine-link" [routerLink]="['/machine', machine.machine_id]">{{
                    machine.name
                  }}</a>
                </li>
              }
            </ul>
          }

          @if (drivers.value().length > 0) {
            <h3>MAME driver rules</h3>
            <ul class="tag-row plain-list">
              @for (driver of drivers.value(); track driver.mame_sourcefile) {
                <li>
                  <code class="tag tag--muted">{{ driver.mame_sourcefile }}</code>
                </li>
              }
            </ul>
          }
        </section>
      } @else {
        <header class="view__head">
          <h1>No such platform family</h1>
          <p class="view__lede">
            Nothing in the catalogue is called <code>{{ systemId() }}</code
            >, and no alias resolves to it.
          </p>
          <p><a class="pixel-button" routerLink="/systems">Browse platform families</a></p>
        </header>
      }
    }
  `,
  styles: `
    :host {
      display: block;
    }

    .caveat {
      margin: 1rem 0 0;
      padding-left: 0.6rem;
      border-left: var(--border-w-thin) solid var(--warn);
      font-size: 0.9375rem;
    }

    .machine-link {
      display: inline-block;
      padding: 0.15rem 0.4rem;
      border: 1px solid var(--border);
      color: var(--fg);
      text-decoration: none;
      font-size: 0.9375rem;
    }

    .machine-link:hover {
      border-color: var(--border-strong);
      text-decoration: underline;
    }
  `,
})
export class SystemDetail {
  private readonly database = inject(DatabaseService);

  readonly systemId = input.required<string>();

  protected readonly unknown = UNKNOWN;
  protected readonly formatCount = formatCount;
  protected readonly formatShare = formatShare;
  protected readonly pluralize = pluralize;

  protected readonly head = queryRow<SystemHead>(() => ({
    sql: SYSTEM_HEAD_SQL,
    params: { ':id': this.systemId() },
  }));

  private readonly resolvedId = computed(() => this.head.value()?.system_id ?? null);

  private spec(sql: string, extra: Record<string, string | number> = {}) {
    return () => {
      const id = this.resolvedId();
      return id === null ? undefined : { sql, params: { ':id': id, ...extra } };
    };
  }

  protected readonly chipset = query<ChipsetRow>(this.spec(CHIPSET_SQL));
  protected readonly platforms = query<PlatformStatus>(this.spec(PLATFORM_STATUS_SQL));

  protected readonly machines = query<{
    readonly machine_id: string;
    readonly name: string;
  }>(
    this.spec(
      'SELECT machine_id, name FROM v_machine WHERE system_id = :id ORDER BY name, machine_id LIMIT :limit',
      { ':limit': MACHINE_SAMPLE },
    ),
  );

  protected readonly drivers = query<{ readonly mame_sourcefile: string }>(
    this.spec(
      'SELECT mame_sourcefile FROM system_driver WHERE system_id = :id ORDER BY mame_sourcefile',
    ),
  );

  protected readonly cores = query<{
    readonly implementation_id: string;
    readonly name: string;
    readonly repo_url: string | null;
    readonly license_id: string | null;
  }>(
    this.spec(`
      SELECT i.implementation_id, i.name, i.repo_url, i.license_id
      FROM implementation_system isy
      JOIN implementation i ON i.implementation_id = isy.implementation_id
      WHERE isy.system_id = :id
      ORDER BY i.name, i.implementation_id`),
  );

  protected readonly pending = computed(() => isPending(this.head)() || this.database.isLoading());
}
