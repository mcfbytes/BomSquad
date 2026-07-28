import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { DataStatus } from '../data/data-status';
import { DatabaseService } from '../data/database';
import { isPending, query, queryRow } from '../data/query';
import { QualityReportService } from '../data/quality-report';
import { CoverageBadge } from '../shared/coverage-badge';
import { UNKNOWN, formatBytes, formatCount, formatShare, pluralize } from '../shared/format';
import { PROSPECTOR_CONFIG } from '../prospector/prospector-config.generated';
import {
  PROSPECTOR_DETAIL_SQL,
  PROSPECTOR_RANK_SQL,
  type ProspectorDetailRow,
  type ProspectorRankRow,
  rankParams,
  rankProspects,
  weightParams,
} from '../prospector/ranking';

/** The platform the dashboard's teaser ranks. The Prospector itself offers all seven. */
const HEADLINE_PLATFORM = 'mister';
const HEADLINE_BOARDS = 5;
const WORKLIST_ROWS = 8;

interface Headline {
  readonly chips: number;
  readonly machines: number;
  readonly systems: number;
  readonly implementations: number;
  readonly projects: number;
  readonly chips_covered: number;
  readonly chips_direct: number;
  readonly machines_with_core: number;
  readonly systems_with_core: number;
  readonly prospector_candidates: number;
}

/**
 * Every headline figure in one statement.
 *
 * `chips_covered` is `v_chip_evidence`, not `COUNT(DISTINCT implementation_chip.chip_id)`:
 * the evidence view is where "this chip is satisfiable by an fpga_hdl implementation"
 * is defined, equivalence routes included, and the dashboard must not be the place a
 * second definition of coverage appears.
 */
const HEADLINE_SQL = `
SELECT (SELECT COUNT(*) FROM chip)                                   AS chips,
       (SELECT COUNT(*) FROM machine)                                AS machines,
       (SELECT COUNT(*) FROM system)                                 AS systems,
       (SELECT COUNT(*) FROM implementation WHERE kind_id = 'fpga_hdl') AS implementations,
       (SELECT COUNT(*) FROM project)                                AS projects,
       (SELECT COUNT(*) FROM v_chip_evidence
         WHERE kind_id = 'fpga_hdl')                                 AS chips_covered,
       (SELECT COUNT(*) FROM v_chip_evidence
         WHERE kind_id = 'fpga_hdl' AND best_via = 'self')           AS chips_direct,
       (SELECT COUNT(DISTINCT machine_id) FROM implementation_machine) AS machines_with_core,
       (SELECT COUNT(DISTINCT system_id) FROM implementation_system)   AS systems_with_core,
       (SELECT COUNT(*) FROM v_prospector
         WHERE platform_id = :platform)                              AS prospector_candidates`;

const BAND_SQL = `
SELECT cf.prospector_band AS band, COUNT(*) AS chips, COUNT(e.chip_id) AS covered
FROM chip c
JOIN chip_function cf ON cf.function_id = c.function_id
LEFT JOIN v_chip_evidence e ON e.kind_id = 'fpga_hdl' AND e.chip_id = c.chip_id
GROUP BY cf.prospector_band
ORDER BY CASE cf.prospector_band WHEN 'hard' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END`;

const WARNINGS_SQL = `
SELECT code, COUNT(*) AS warnings
FROM v_quality_warning
GROUP BY code
ORDER BY warnings DESC, code`;

/**
 * Home / dashboard (PLAN §5 view 1, TASKS T7.9).
 *
 * **Nothing on this page is hardcoded.** Every number is either a `SELECT` against the
 * shipped views or a scalar out of `dist/quality-report.json`, and the two are labelled
 * so a reader can tell which. Where a figure is unavailable — no database, no published
 * report — the tile says so and prints an em dash instead of a zero.
 *
 * The hero is one of exactly two elements allowed to carry the CRT texture (the masthead
 * is the other). Everything below it is data, and data gets no decoration.
 */
@Component({
  selector: 'app-home',
  imports: [RouterLink, CoverageBadge, DataStatus],
  template: `
    <section class="hero panel crt">
      <div class="hero__inner">
        <p class="eyebrow">Insert coin</p>
        <h1>BOM Squad</h1>
        <p class="hero__lede">
          An open database mapping arcade boards and consoles to their chip bills-of-materials,
          linking those chips to open-source FPGA implementations, and surfacing the boards that are
          ready to become cores but don't have one yet.
        </p>
        <p class="hero__actions">
          <a class="pixel-button" routerLink="/prospector">Open the Prospector</a>
          <a class="pixel-button" routerLink="/machines">Browse machines</a>
        </p>
      </div>
    </section>

    <app-data-status
      [loading]="pending()"
      [error]="headline.error()"
      loadingLabel="Loading the dataset…"
      (retry)="headline.reload()"
    />

    @if (!pending() && headline.error() === undefined) {
      @if (headline.value(); as stats) {
        <section class="section" aria-labelledby="stats-heading">
          <h2 id="stats-heading">Headline stats</h2>
          <div class="stats">
            <div class="panel panel--flat stat">
              <span class="stat__value">{{ formatCount(stats.chips) }}</span>
              <span class="stat__label">Chips catalogued</span>
            </div>
            <div class="panel panel--flat stat">
              <span class="stat__value">{{ formatShare(coveredShare(stats)) }}</span>
              <span class="stat__label"
                >Chips with FPGA HDL ({{ formatCount(stats.chips_covered) }} of
                {{ formatCount(stats.chips) }})</span
              >
            </div>
            <div class="panel panel--flat stat">
              <span class="stat__value">{{ formatCount(stats.machines) }}</span>
              <span class="stat__label">Machines tracked</span>
            </div>
            <div class="panel panel--flat stat">
              <span class="stat__value">{{ formatCount(stats.systems) }}</span>
              <span class="stat__label"
                >Platform families ({{ formatCount(stats.systems_with_core) }} with a core)</span
              >
            </div>
            <div class="panel panel--flat stat">
              <span class="stat__value">{{ formatCount(stats.implementations) }}</span>
              <span class="stat__label"
                >FPGA implementations, from {{ formatCount(stats.projects) }} projects</span
              >
            </div>
            <div class="panel panel--flat stat">
              <span class="stat__value">{{ formatCount(stats.machines_with_core) }}</span>
              <span class="stat__label">Machines a core names directly</span>
            </div>
          </div>
          <p class="note">
            Every figure above is a query against the shipped database, run in your browser.
            {{ formatCount(stats.chips_direct) }} of the covered chips have an implementation naming
            the part; the rest reach coverage through a curated equivalence.
          </p>
        </section>

        <section class="section" aria-labelledby="viable-heading">
          <div class="section__head">
            <h2 id="viable-heading">Closest to a core</h2>
            <a routerLink="/prospector">All {{ formatCount(stats.prospector_candidates) }} →</a>
          </div>
          @if (topBoards().length === 0) {
            <p class="empty">
              No core-less board is left on {{ headlinePlatform }} — or the ranking has not loaded
              yet.
            </p>
          } @else {
            <ol class="viable plain-list">
              @for (board of topBoards(); track board.systemId) {
                <li class="panel panel--flat viable__row">
                  <p class="viable__title">
                    <span class="viable__rank" aria-hidden="true">#{{ board.rank }}</span>
                    <a [routerLink]="['/system', board.systemId]">{{ board.systemName }}</a>
                    <span class="viable__score">{{ board.score.toFixed(3) }}</span>
                  </p>
                  <p class="viable__signals">
                    <app-coverage-badge
                      size="sm"
                      [covered]="board.breakdown.chips.satisfied"
                      [total]="board.breakdown.chips.total"
                    />
                    <span
                      class="tag"
                      [class.tag--ok]="board.breakdown.confidence.level === 'high'"
                      [class.tag--warn]="board.breakdown.confidence.level === 'medium'"
                      [class.tag--bad]="board.breakdown.confidence.level === 'low'"
                      >{{ board.breakdown.confidence.level }} confidence</span
                    >
                    @if (board.breakdown.unmappedDevices.count; as unmapped) {
                      <span class="tag tag--muted">{{ unmapped }} unmapped</span>
                    }
                  </p>
                  <p class="viable__missing">
                    @if (board.breakdown.chips.missing.length === 0) {
                      Every catalogued chip on this board already has an implementation.
                    } @else {
                      Missing:
                      @for (chip of board.breakdown.chips.missing.slice(0, 3); track chip.chipId) {
                        <a [routerLink]="['/chip', chip.chipId]"
                          >{{ chip.chipId }} ({{ chip.band }})</a
                        >
                      }
                      @if (board.breakdown.chips.missing.length > 3) {
                        + {{ board.breakdown.chips.missing.length - 3 }} more
                      }
                    }
                  </p>
                </li>
              }
            </ol>
            <p class="note">
              Ranked for {{ headlinePlatform }} by <code>pipeline/config/prospector.json</code> v{{
                configVersion
              }}
              — the same score <code>pipeline prospector</code> prints. A high chip share with a low
              confidence means most of that board is not catalogued yet, not that it is nearly done.
            </p>
          }
        </section>

        <div class="columns">
          <section class="section" aria-labelledby="bands-heading">
            <h2 id="bands-heading">Where the gaps are</h2>
            <p class="note">
              Chips by their function's difficulty band. The <code>hard</code> band — customs,
              protection, the video pipeline — is where an FPGA port's cost actually sits.
            </p>
            <ul class="plain-list bands">
              @for (band of bands.value(); track band.band) {
                <li class="band">
                  <p class="band__head">
                    <span class="band__name">{{ band.band }}</span>
                    <span class="band__count"
                      >{{ formatCount(band.covered) }} / {{ formatCount(band.chips) }} covered</span
                    >
                  </p>
                  <span
                    class="bar"
                    role="img"
                    [attr.aria-label]="
                      band.covered + ' of ' + band.chips + ' ' + band.band + '-band chips covered'
                    "
                  >
                    <span
                      class="bar__fill"
                      [class.bar__fill--bad]="band.band === 'hard'"
                      [class.bar__fill--warn]="band.band === 'medium'"
                      [class.bar__fill--ok]="band.band === 'soft'"
                      [style.width.%]="percent(band.covered, band.chips)"
                    ></span>
                  </span>
                </li>
              }
            </ul>
            <p class="note">
              <a routerLink="/chips" [queryParams]="{ status: 'missing' }"
                >Every uncovered chip →</a
              >
            </p>
          </section>

          <section class="section" aria-labelledby="worklist-heading">
            <h2 id="worklist-heading">Top of the mapping worklist</h2>
            <p class="note">
              The MAME devices that appear most often and are still unmapped — straight out of
              <code>v_mame_device_worklist</code>. Mapping one of these moves every board that
              carries it.
            </p>
            <div class="table-scroll">
              <table>
                <caption>
                  Ordered by instance count, then by how many machines carry the device.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">MAME device</th>
                    <th scope="col" class="num">Machines</th>
                    <th scope="col" class="num">Instances</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of worklist.value(); track row.mame_device) {
                    <tr>
                      <th scope="row">
                        <code>{{ row.mame_device }}</code>
                      </th>
                      <td class="num">{{ formatCount(row.machine_count) }}</td>
                      <td class="num">{{ formatCount(row.instance_count) }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            <p class="note"><a routerLink="/contribute">How to map a device →</a></p>
          </section>
        </div>

        <section class="section" aria-labelledby="quality-heading">
          <h2 id="quality-heading">This dataset</h2>
          <dl class="meta">
            <dt>Dataset version</dt>
            <dd>{{ meta('dataset_version') }} · built {{ meta('build_date') }}</dd>
            <dt>MAME release</dt>
            <dd>{{ meta('mame_version') }}</dd>
            <dt>Schema</dt>
            <dd>{{ meta('schema_version') }}</dd>
            @if (instances.value(); as counted) {
              <dt>Device instances mapped</dt>
              <dd>
                {{ formatShare(counted.mapped_instance_share) }} —
                {{ formatCount(counted.mapped_instances) }} of
                {{ formatCount(counted.total_instances) }} device instances across every machine
                resolve to a catalogued chip. The remainder are the worklist above.
              </dd>
            }
            @if (devices.value(); as counted) {
              <dt>MAME devices</dt>
              <dd>
                {{ formatCount(counted.devices_mapped) }} mapped ·
                {{ formatCount(counted.devices_ignored) }} deliberately ignored ·
                {{ formatCount(counted.devices_unmapped) }} unmapped
              </dd>
            }
            @if (report(); as published) {
              <dt>Published artifact</dt>
              <dd>
                {{ formatBytes(published.db_bytes) }} · quality thresholds v{{
                  published.threshold_version
                }}
                <span class="tag tag--muted">from dist/quality-report.json</span>
              </dd>
            } @else {
              <dt>Published artifact</dt>
              <dd>
                <code>quality-report.json</code> was not published with this build, so the artifact
                size and threshold policy are not known here.
              </dd>
            }
          </dl>

          <h3>Open quality warnings</h3>
          @if (warnings.value().length === 0) {
            <p class="empty">
              No warning in <code>v_quality_warning</code> fires against this build.
            </p>
          } @else {
            <p class="note">
              Live from <code>v_quality_warning</code>. Every one of these is a curation task, not a
              bug: the dataset says what it has not checked yet.
            </p>
            <ul class="tag-row plain-list">
              @for (warning of warnings.value(); track warning.code) {
                <li>
                  <span class="tag tag--muted"
                    >{{ warning.code }} · {{ formatCount(warning.warnings) }}</span
                  >
                </li>
              }
            </ul>
          }
        </section>
      }
    }
  `,
  styles: `
    :host {
      display: block;
    }

    .hero {
      padding: 2.5rem 1.5rem;
      margin-bottom: 2.5rem;
    }

    .hero__inner {
      max-width: 62ch;
    }

    .hero__lede {
      font-size: 1.0625rem;
      color: var(--fg);
    }

    .hero__actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.75rem;
      margin-bottom: 0;
    }

    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
      gap: 1rem;
    }

    .columns {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(21rem, 1fr));
      gap: 2rem;
      margin-bottom: 2.5rem;
    }

    .columns .section {
      margin-bottom: 0;
    }

    .viable__row + .viable__row {
      margin-top: 0.75rem;
    }

    .viable__title {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 0.5rem;
      margin: 0;
    }

    .viable__rank,
    .viable__score {
      font-family: var(--font-display);
      font-size: var(--display-sm);
      -webkit-font-smoothing: none;
    }

    .viable__rank {
      color: var(--muted);
    }

    .viable__score {
      margin-left: auto;
      color: var(--accent);
      font-variant-numeric: tabular-nums;
    }

    .viable__signals {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.35rem;
      margin: 0.5rem 0 0;
    }

    .viable__missing {
      margin: 0.5rem 0 0;
      font-size: 0.9375rem;
    }

    .viable__missing a + a::before {
      content: ', ';
      color: var(--muted);
    }

    .band + .band {
      margin-top: 0.75rem;
    }

    .band__head {
      display: flex;
      justify-content: space-between;
      gap: 1rem;
      margin: 0 0 0.2rem;
      font-size: 0.875rem;
    }

    .band__name {
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }

    .band__count {
      color: var(--muted);
      font-variant-numeric: tabular-nums;
    }
  `,
})
export class Home {
  private readonly database = inject(DatabaseService);
  private readonly quality = inject(QualityReportService);

  protected readonly unknown = UNKNOWN;
  protected readonly formatCount = formatCount;
  protected readonly formatShare = formatShare;
  protected readonly formatBytes = formatBytes;
  protected readonly pluralize = pluralize;
  protected readonly configVersion = PROSPECTOR_CONFIG.version;
  protected readonly headlinePlatform = 'MiSTer';

  protected readonly headline = queryRow<Headline>(() => ({
    sql: HEADLINE_SQL,
    params: { ':platform': HEADLINE_PLATFORM },
  }));

  protected readonly bands = query<{
    readonly band: string;
    readonly chips: number;
    readonly covered: number;
  }>(() => ({ sql: BAND_SQL }));

  protected readonly worklist = query<{
    readonly mame_device: string;
    readonly machine_count: number;
    readonly instance_count: number;
  }>(() => ({
    sql: `SELECT mame_device, machine_count, instance_count
          FROM v_mame_device_worklist
          ORDER BY instance_count DESC, machine_count DESC, mame_device
          LIMIT :limit`,
    params: { ':limit': WORKLIST_ROWS },
  }));

  protected readonly warnings = query<{ readonly code: string; readonly warnings: number }>(() => ({
    sql: WARNINGS_SQL,
  }));

  protected readonly instances = queryRow<{
    readonly mapped_instances: number;
    readonly total_instances: number;
    readonly mapped_instance_share: number;
  }>(() => ({ sql: 'SELECT * FROM v_quality_instance' }));

  protected readonly devices = queryRow<{
    readonly devices_mapped: number;
    readonly devices_ignored: number;
    readonly devices_unmapped: number;
  }>(() => ({ sql: 'SELECT * FROM v_quality_device' }));

  private readonly datasetMeta = query<{ readonly key: string; readonly value: string }>(() => ({
    sql: 'SELECT key, value FROM dataset_meta ORDER BY key',
  }));

  /** The dashboard teaser runs the same ranking the Prospector does — no second score. */
  private readonly rankRows = query<ProspectorRankRow>(() => ({
    sql: PROSPECTOR_RANK_SQL,
    params: rankParams(PROSPECTOR_CONFIG, HEADLINE_PLATFORM),
  }));

  private readonly detailRows = query<ProspectorDetailRow>(() => ({
    sql: PROSPECTOR_DETAIL_SQL,
    params: weightParams(PROSPECTOR_CONFIG),
  }));

  protected readonly topBoards = computed(() =>
    rankProspects(
      this.rankRows.value(),
      this.detailRows.value(),
      PROSPECTOR_CONFIG,
      HEADLINE_PLATFORM,
    ).entries.slice(0, HEADLINE_BOARDS),
  );

  protected readonly report = computed(() => this.quality.report.value());

  protected readonly pending = computed(
    () => isPending(this.headline)() || this.database.isLoading(),
  );

  protected meta(key: string): string {
    return this.datasetMeta.value().find((row) => row.key === key)?.value ?? UNKNOWN;
  }

  protected coveredShare(stats: Headline): number | null {
    return stats.chips === 0 ? null : stats.chips_covered / stats.chips;
  }

  protected percent(part: number, whole: number): number {
    return whole === 0 ? 0 : Math.round((part / whole) * 100);
  }
}
