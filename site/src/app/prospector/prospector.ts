import { Component, computed, inject, input, signal } from '@angular/core';
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
import { PROSPECTOR_CONFIG } from './prospector-config.generated';
import {
  PROSPECTOR_DETAIL_SQL,
  PROSPECTOR_RANK_SQL,
  type ProspectorBand,
  type ProspectorDetailRow,
  type ProspectorEntry,
  type ProspectorRankRow,
  rankParams,
  rankProspects,
  weightParams,
} from './ranking';

/** The platform the page opens on when the URL does not name one. */
const DEFAULT_PLATFORM = 'mister';

/** Boards rendered before "show more". */
const PAGE_SIZE = 25;

interface ChipName {
  readonly chip_id: string;
  readonly display_name: string;
}

/** A missing chip, resolved to something a person can read and click. */
interface MissingChipView {
  readonly chipId: string;
  readonly label: string;
  readonly band: ProspectorBand;
}

interface BoardView {
  readonly entry: ProspectorEntry;
  readonly manufacturerName: string | null;
  readonly kindLabel: string;
  readonly missing: readonly MissingChipView[];
  /** Every reason to distrust this row's headline coverage, in plain words. */
  readonly caveats: readonly string[];
}

/**
 * 🔦 The Prospector (PLAN §5 view 7, TASKS T7.7) — the flagship.
 *
 * Core-less boards on one FPGA platform, ranked by T6.3's weighted score, with what is
 * missing named inline and the whole score breakdown one button away.
 *
 * **The ranking is T6.3's, not this component's.** `ranking.ts` is a verbatim port of
 * `pipeline/src/prospector/rank.ts`, and `site/tools/verify-prospector-parity.mjs` runs
 * both implementations over the same database and compares every field of every entry
 * on every platform. This component only decides what to *show*.
 *
 * **What it refuses to hide.** `v_prospector` publishes a `confidence` level and an
 * `unmapped_device_count` beside its chip counts, and PLAN §8 names the trap they exist
 * for: a board can read 6/6 chips satisfied purely because six of its devices are not
 * catalogued yet — and its whole video system is one of them. The ranking already
 * demotes that board. Applying the demotion *silently* would leave the page telling the
 * visitor exactly the lie the score was corrected for, so every row carries its
 * confidence level, its unmapped count, and a sentence saying what they mean, next to
 * the coverage badge rather than buried in the expansion.
 *
 * **Filters live in the URL.** Platform, kind, manufacturer, free text and which board
 * is expanded are query parameters bound straight to the `input()`s below, so a pasted
 * link reproduces the exact view after a cold load. Filtering never renumbers: rank #7
 * stays #7 when the list narrows, because the rank is a property of the board on that
 * platform, not of the current filter.
 */
@Component({
  selector: 'app-prospector',
  imports: [RouterLink, CoverageBadge, DataStatus],
  template: `
    <header class="view__head">
      <p class="eyebrow">Ranked by weighted readiness</p>
      <h1>The Prospector</h1>
      <p class="view__lede">
        Boards with no core on this platform, ranked by how much of their bill of materials already
        exists as open HDL — weighted by how hard the missing parts are, and demoted when the
        catalogue is too thin to trust. Scoring policy:
        <code>pipeline/config/prospector.json</code> v{{ configVersion }}.
      </p>
    </header>

    <form class="filters" (submit)="$event.preventDefault()">
      <div class="filters__field">
        <label class="filters__label" for="prospector-platform">Target platform</label>
        <select
          id="prospector-platform"
          class="filters__control"
          [value]="platformId()"
          (change)="setParam('platform', $event)"
        >
          @for (row of platforms.value(); track row.platform_id) {
            <option [value]="row.platform_id">{{ row.label }}</option>
          }
        </select>
      </div>

      <div class="filters__field">
        <label class="filters__label" for="prospector-kind">Kind</label>
        <select
          id="prospector-kind"
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
        <label class="filters__label" for="prospector-manufacturer">Manufacturer</label>
        <select
          id="prospector-manufacturer"
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

      <div class="filters__field filters__field--wide">
        <label class="filters__label" for="prospector-q">Board name contains</label>
        <input
          id="prospector-q"
          class="filters__control"
          type="search"
          autocomplete="off"
          [value]="q()"
          (input)="setParam('q', $event)"
        />
      </div>

      <div class="filters__actions">
        <button type="button" class="pixel-button" (click)="reset()">Reset</button>
      </div>
    </form>

    <app-data-status
      [loading]="pending()"
      [error]="failure()"
      loadingLabel="Ranking boards…"
      (retry)="reload()"
    />

    @if (!pending() && failure() === undefined) {
      <p class="result-count">
        <strong>{{ formatCount(boards().length) }}</strong> of
        {{ pluralize(ranking().candidateCount, 'core-less board') }} on {{ platformLabel()
        }}{{ filtered() ? ', matching these filters' : '' }}. Ranks belong to the platform, so
        narrowing the list never renumbers it.
      </p>

      @if (boards().length === 0) {
        <p class="empty">
          @if (ranking().candidateCount === 0) {
            Every catalogued system already has an FPGA core on {{ platformLabel() }} — there is
            nothing left to prospect here. Try another target platform.
          } @else {
            No board on {{ platformLabel() }} matches these filters.
          }
        </p>
      } @else {
        <ol class="boards">
          @for (board of visibleBoards(); track board.entry.systemId) {
            <li class="board panel panel--flat">
              <div class="board__head">
                <span class="board__rank" aria-hidden="true">#{{ board.entry.rank }}</span>
                <div class="board__title">
                  <h2>
                    <a [routerLink]="['/system', board.entry.systemId]">
                      <span class="sr-only">Rank {{ board.entry.rank }}: </span>
                      {{ board.entry.systemName }}
                    </a>
                  </h2>
                  <p class="board__sub">
                    {{ board.manufacturerName ?? unknown }} · {{ board.kindLabel }} ·
                    {{ board.entry.yearIntroduced ?? unknown }} ·
                    <code>{{ board.entry.systemId }}</code>
                  </p>
                </div>
                <p class="board__score">
                  <span class="board__score-value">{{ board.entry.score.toFixed(3) }}</span>
                  <span class="board__score-label">score</span>
                </p>
              </div>

              <div class="board__signals">
                <app-coverage-badge
                  size="sm"
                  [covered]="board.entry.breakdown.chips.satisfied"
                  [total]="board.entry.breakdown.chips.total"
                />
                <span
                  class="tag"
                  [class.tag--ok]="board.entry.breakdown.confidence.level === 'high'"
                  [class.tag--warn]="board.entry.breakdown.confidence.level === 'medium'"
                  [class.tag--bad]="board.entry.breakdown.confidence.level === 'low'"
                  >{{ board.entry.breakdown.confidence.level }} confidence</span
                >
                @if (board.entry.breakdown.unmappedDevices.count; as unmapped) {
                  <span class="tag tag--muted"
                    >{{ unmapped }} unmapped {{ unmapped === 1 ? 'device' : 'devices' }}</span
                  >
                }
                @if (board.entry.breakdown.systemMateCore.mateSystemId; as mate) {
                  <span class="tag"
                    >mate core: <a [routerLink]="['/system', mate]">{{ mate }}</a></span
                  >
                }
                @if (board.entry.breakdown.cpuSoundComplete.applied) {
                  <span class="tag">CPU + sound complete</span>
                }
              </div>

              @for (caveat of board.caveats; track caveat) {
                <p class="board__caveat">{{ caveat }}</p>
              }

              <p class="board__missing">
                <span class="board__missing-label">Missing</span>
                @if (board.missing.length === 0) {
                  <span class="board__none"
                    >nothing catalogued — every chip in the known BOM is covered.</span
                  >
                } @else {
                  @for (chip of board.missing; track chip.chipId) {
                    <a class="chip-gap" [routerLink]="['/chip', chip.chipId]">
                      {{ chip.label }}
                      <span
                        class="tag"
                        [class.tag--bad]="chip.band === 'hard'"
                        [class.tag--warn]="chip.band === 'medium'"
                        [class.tag--muted]="chip.band === 'soft'"
                        >{{ chip.band }}</span
                      >
                    </a>
                  }
                }
              </p>

              <p class="board__actions">
                <button
                  type="button"
                  class="pixel-button"
                  [attr.aria-expanded]="isOpen(board.entry.systemId)"
                  [attr.aria-controls]="'breakdown-' + board.entry.systemId"
                  (click)="toggle(board.entry.systemId)"
                >
                  {{ isOpen(board.entry.systemId) ? 'Hide the maths' : 'Why this rank?' }}
                </button>
              </p>

              @if (isOpen(board.entry.systemId)) {
                <section
                  class="breakdown"
                  [id]="'breakdown-' + board.entry.systemId"
                  [attr.aria-label]="'Score breakdown for ' + board.entry.systemName"
                >
                  <p class="breakdown__formula">
                    <strong>{{ board.entry.score.toFixed(6) }}</strong> = readiness
                    {{ board.entry.breakdown.readiness.value.toFixed(6) }} × confidence
                    {{ board.entry.breakdown.confidence.factor }} × system-mate
                    {{ board.entry.breakdown.systemMateCore.factor }} × CPU+sound
                    {{ board.entry.breakdown.cpuSoundComplete.factor }}
                  </p>

                  <div class="table-scroll">
                    <table>
                      <caption>
                        Every factor at the value actually applied (T6.3
                        <code>ScoreBreakdown</code>
                        ).
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">Factor</th>
                          <th scope="col" class="num">Value</th>
                          <th scope="col">Why</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <th scope="row">Readiness</th>
                          <td class="num">
                            {{ board.entry.breakdown.readiness.value.toFixed(6) }}
                          </td>
                          <td>
                            {{ board.entry.breakdown.readiness.satisfiedWeight }} satisfied weight ÷
                            ({{ board.entry.breakdown.readiness.chipWeight }} catalogued chip weight
                            + {{ board.entry.breakdown.readiness.unmappedWeight }} unmapped-device
                            weight). Sockets weigh hard {{ bandWeight.hard }} / medium
                            {{ bandWeight.medium }} / soft {{ bandWeight.soft }}; an equivalence
                            route earns {{ routeCredit.equivalent }} and a <em>provides</em> route
                            {{ routeCredit.provides }} of its weight.
                          </td>
                        </tr>
                        <tr>
                          <th scope="row">Confidence</th>
                          <td class="num">{{ board.entry.breakdown.confidence.factor }}</td>
                          <td>
                            <code>{{ board.entry.breakdown.confidence.level }}</code> from
                            <code>v_system_coverage_by_kind</code>:
                            {{ board.entry.breakdown.unmappedDevices.count }} unmapped MAME
                            device(s), {{ board.entry.breakdown.chips.viaEdge.length }} socket(s)
                            satisfied by substitution rather than by their own HDL.
                          </td>
                        </tr>
                        <tr>
                          <th scope="row">System-mate core</th>
                          <td class="num">{{ board.entry.breakdown.systemMateCore.factor }}</td>
                          <td>
                            @if (board.entry.breakdown.systemMateCore.mateSystemId; as mate) {
                              <a [routerLink]="['/system', mate]">{{ mate }}</a> already has an FPGA
                              core and shares
                              {{ board.entry.breakdown.systemMateCore.sharedChips }} chips with this
                              board, so the HDL and the porting experience exist.
                            } @else {
                              No system sharing at least {{ mateMinSharedChips }} chips with this
                              board has an FPGA core anywhere.
                            }
                          </td>
                        </tr>
                        <tr>
                          <th scope="row">CPU + sound</th>
                          <td class="num">{{ board.entry.breakdown.cpuSoundComplete.factor }}</td>
                          <td>
                            {{ board.entry.breakdown.cpuSoundComplete.cpuChips }} CPU/MCU and
                            {{ board.entry.breakdown.cpuSoundComplete.soundChips }} sound sockets.
                            @if (board.entry.breakdown.cpuSoundComplete.applied) {
                              All of them are satisfied.
                            } @else if (
                              board.entry.breakdown.cpuSoundComplete.missingChipIds.length
                            ) {
                              Still missing
                              {{
                                board.entry.breakdown.cpuSoundComplete.missingChipIds.join(', ')
                              }}.
                            } @else {
                              The bonus needs at least one of each, and this BOM has not got both.
                            }
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>

                  <div class="breakdown__cols">
                    <div>
                      <h3>Sockets by band</h3>
                      <div class="table-scroll">
                        <table>
                          <caption>
                            The band is a prior on the chip's function, not a measurement of the
                            part.
                          </caption>
                          <thead>
                            <tr>
                              <th scope="col">Band</th>
                              <th scope="col" class="num">Satisfied</th>
                              <th scope="col" class="num">Missing</th>
                              <th scope="col" class="num">Weight each</th>
                            </tr>
                          </thead>
                          <tbody>
                            @for (band of bands; track band) {
                              <tr>
                                <th scope="row">{{ band }}</th>
                                <td class="num">
                                  {{ board.entry.breakdown.chips.byBand[band].satisfied }}
                                </td>
                                <td class="num">
                                  {{ board.entry.breakdown.chips.byBand[band].missing }}
                                </td>
                                <td class="num">{{ bandWeight[band] }}</td>
                              </tr>
                            }
                          </tbody>
                        </table>
                      </div>
                    </div>

                    <div>
                      <h3>Satisfied by substitution</h3>
                      @if (board.entry.breakdown.chips.viaEdge.length === 0) {
                        <p class="note">
                          Nothing here leans on an equivalence claim — every satisfied socket has an
                          implementation naming that exact part.
                        </p>
                      } @else {
                        <ul class="plain-list">
                          @for (edge of board.entry.breakdown.chips.viaEdge; track edge.chipId) {
                            <li>
                              <a [routerLink]="['/chip', edge.chipId]">{{ edge.chipId }}</a>
                              via <code>{{ edge.via }}</code>
                              <a [routerLink]="['/chip', edge.providerChipId]">{{
                                edge.providerChipId
                              }}</a>
                              — {{ edge.credit }} credit
                            </li>
                          }
                        </ul>
                      }
                    </div>
                  </div>

                  <p class="note">
                    <a [routerLink]="['/system', board.entry.systemId]"
                      >Open the full chipset and member machines for {{ board.entry.systemName }}</a
                    >.
                  </p>
                </section>
              }
            </li>
          }
        </ol>

        @if (visibleBoards().length < boards().length) {
          <div class="pager">
            <button type="button" class="pixel-button" (click)="showMore()">
              Show {{ formatCount(boards().length - visibleBoards().length) }} more
            </button>
            <p class="pager__status">
              Showing {{ visibleBoards().length }} of {{ formatCount(boards().length) }}.
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

    .boards {
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .board + .board {
      margin-top: 1rem;
    }

    .board__head {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 0.5rem 1rem;
    }

    .board__rank {
      font-family: var(--font-display);
      font-size: var(--display-sm);
      color: var(--muted);
      -webkit-font-smoothing: none;
    }

    .board__title {
      flex: 1 1 18rem;
      min-width: 0;
    }

    .board__title h2 {
      margin-bottom: 0.25rem;
      font-size: var(--display-sm);
    }

    .board__sub {
      margin: 0;
      color: var(--muted);
      font-size: 0.875rem;
    }

    .board__score {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      margin: 0;
      text-align: right;
    }

    .board__score-value {
      font-family: var(--font-display);
      font-size: var(--display-sm);
      color: var(--accent);
      font-variant-numeric: tabular-nums;
      -webkit-font-smoothing: none;
    }

    .board__score-label {
      font-size: var(--label-sm);
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--muted);
    }

    .board__signals {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.4rem;
      margin-top: 0.75rem;
    }

    /* The honesty line. Not a footnote and not a colour — a sentence. */
    .board__caveat {
      margin: 0.6rem 0 0;
      padding-left: 0.6rem;
      border-left: var(--border-w-thin) solid var(--warn);
      color: var(--fg);
      font-size: 0.875rem;
    }

    .board__missing {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.35rem;
      margin: 0.75rem 0 0;
      font-size: 0.9375rem;
    }

    .board__missing-label,
    .board__none {
      color: var(--muted);
    }

    .board__missing-label {
      font-size: var(--label-sm);
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }

    .chip-gap {
      display: inline-flex;
      align-items: center;
      gap: 0.3rem;
      padding: 0.1rem 0.3rem;
      color: var(--fg);
      text-decoration: none;
      border: 1px solid var(--border);
    }

    .chip-gap:hover {
      border-color: var(--border-strong);
      text-decoration: underline;
    }

    .board__actions {
      margin: 0.9rem 0 0;
    }

    .breakdown {
      margin-top: 1rem;
      padding-top: 1rem;
      border-top: var(--border-w-thin) solid var(--border);
    }

    .breakdown__formula {
      font-variant-numeric: tabular-nums;
      overflow-wrap: anywhere;
    }

    .breakdown__cols {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
      gap: 1.5rem;
      margin-top: 1.5rem;
    }
  `,
})
export class Prospector {
  private readonly database = inject(DatabaseService);
  private readonly write = queryParamWriter();

  /** Query parameters, bound by `withComponentInputBinding()`. The URL *is* the state. */
  readonly platform = input('', { transform: param });
  readonly kind = input('', { transform: param });
  readonly manufacturer = input('', { transform: param });
  readonly q = input('', { transform: param });
  /** Which board's breakdown is expanded — deep-linkable like everything else. */
  readonly open = input('', { transform: param });

  protected readonly unknown = UNKNOWN;
  protected readonly bands: readonly ProspectorBand[] = ['hard', 'medium', 'soft'];
  protected readonly bandWeight = PROSPECTOR_CONFIG.bandWeight;
  protected readonly routeCredit = PROSPECTOR_CONFIG.routeCredit;
  protected readonly mateMinSharedChips = PROSPECTOR_CONFIG.systemMateMinSharedChips;
  protected readonly configVersion = PROSPECTOR_CONFIG.version;
  protected readonly formatCount = formatCount;
  protected readonly pluralize = pluralize;

  protected readonly platforms = queryAll('fpga_platform', { orderBy: 'label' });
  protected readonly kinds = queryAll('system_kind', { orderBy: 'label' });
  protected readonly manufacturers = queryAll('manufacturer', { orderBy: 'name' });

  protected readonly platformId = computed(() => {
    const requested = this.platform().trim();
    if (requested === '') {
      return DEFAULT_PLATFORM;
    }
    // An unknown platform in a stale link would rank an empty candidate set with no
    // explanation; falling back keeps the page useful and the select honest about
    // what it is actually showing.
    const known = this.platforms.value();
    return known.length === 0 || known.some((row) => row.platform_id === requested)
      ? requested
      : DEFAULT_PLATFORM;
  });

  protected readonly rankRows = query<ProspectorRankRow>(() => ({
    sql: PROSPECTOR_RANK_SQL,
    params: rankParams(PROSPECTOR_CONFIG, this.platformId()),
  }));

  /** Platform-independent, so this runs once however often the platform changes. */
  protected readonly detailRows = query<ProspectorDetailRow>(() => ({
    sql: PROSPECTOR_DETAIL_SQL,
    params: weightParams(PROSPECTOR_CONFIG),
  }));

  protected readonly chipNames = query<ChipName>(() => ({
    sql: 'SELECT chip_id, display_name FROM chip ORDER BY chip_id',
  }));

  protected readonly failure = computed(() => this.rankRows.error() ?? this.detailRows.error());

  protected readonly pending = computed(
    () => isPending(this.rankRows)() || isPending(this.detailRows)() || this.database.isLoading(),
  );

  protected readonly ranking = computed(() =>
    rankProspects(
      this.rankRows.value(),
      this.detailRows.value(),
      PROSPECTOR_CONFIG,
      this.platformId(),
    ),
  );

  private readonly chipLabel = computed(
    () => new Map(this.chipNames.value().map((row) => [row.chip_id, row.display_name])),
  );

  private readonly manufacturerName = computed(
    () => new Map(this.manufacturers.value().map((row) => [row.manufacturer_id, row.name])),
  );

  private readonly kindLabel = computed(
    () => new Map(this.kinds.value().map((row) => [row.kind_id, row.label])),
  );

  /** Every entry, decorated for display. Rank numbers come from the ranking untouched. */
  private readonly allBoards = computed<readonly BoardView[]>(() => {
    const chips = this.chipLabel();
    const makers = this.manufacturerName();
    const kinds = this.kindLabel();

    return this.ranking().entries.map((entry): BoardView => {
      const { breakdown } = entry;
      const caveats: string[] = [];
      const unmapped = breakdown.unmappedDevices.count;

      if (unmapped > 0) {
        caveats.push(
          `${unmapped} MAME ${unmapped === 1 ? 'device' : 'devices'} on this board ` +
            `${unmapped === 1 ? 'is' : 'are'} not catalogued yet, so the ` +
            `${breakdown.chips.satisfied}/${breakdown.chips.total} chip figure only covers the ` +
            `silicon that is. Uncatalogued parts enter the score near the hard band ` +
            `(${breakdown.unmappedDevices.weightEach} each), which is why this board ranks below ` +
            `its nominal share.`,
        );
      }
      if (breakdown.confidence.level !== 'high') {
        caveats.push(
          `Coverage confidence is ${breakdown.confidence.level}, costing a ` +
            `×${breakdown.confidence.factor} multiplier.`,
        );
      }
      if (breakdown.chips.viaEdge.length > 0) {
        const count = breakdown.chips.viaEdge.length;
        caveats.push(
          `${count} ${count === 1 ? 'socket counts' : 'sockets count'} as covered only through a ` +
            `curated equivalence, not through an implementation naming the part.`,
        );
      }

      const manufacturerId = entry.manufacturerId;

      return {
        entry,
        manufacturerName:
          manufacturerId === null ? null : (makers.get(manufacturerId) ?? manufacturerId),
        kindLabel: kinds.get(entry.systemKindId) ?? entry.systemKindId,
        missing: breakdown.chips.missing.map((chip) => ({
          chipId: chip.chipId,
          label: chips.get(chip.chipId) ?? chip.chipId,
          band: chip.band,
        })),
        caveats,
      };
    });
  });

  protected readonly boards = computed(() => {
    const kind = this.kind().trim();
    const maker = this.manufacturer().trim();
    const term = this.q();

    return this.allBoards().filter((board) => {
      if (kind !== '' && board.entry.systemKindId !== kind) {
        return false;
      }
      if (maker !== '' && board.entry.manufacturerId !== maker) {
        return false;
      }
      return matchesText(term, board.entry.systemName, board.entry.systemId);
    });
  });

  protected readonly filtered = computed(
    () => this.kind() !== '' || this.manufacturer() !== '' || this.q().trim() !== '',
  );

  /** Only the manufacturers that actually have a candidate on this platform. */
  protected readonly manufacturersInPlay = computed(() => {
    const names = this.manufacturerName();
    const ids = new Set(
      this.allBoards()
        .map((board) => board.entry.manufacturerId)
        .filter((id) => id !== null),
    );
    return [...ids]
      .map((id) => ({ id, name: names.get(id) ?? id }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  protected readonly platformLabel = computed(() => {
    const row = this.platforms.value().find((entry) => entry.platform_id === this.platformId());
    return row?.label ?? this.platformId();
  });

  private readonly pages = signal(1);

  protected readonly visibleBoards = computed(() =>
    this.boards().slice(0, this.pages() * PAGE_SIZE),
  );

  protected isOpen(systemId: string): boolean {
    return this.open() === systemId;
  }

  protected toggle(systemId: string): void {
    this.write({ open: this.isOpen(systemId) ? null : systemId });
  }

  protected setParam(key: string, event: Event): void {
    this.write({ [key]: paramValue(controlValue(event)) });
  }

  protected reset(): void {
    this.write({ kind: null, manufacturer: null, q: null, open: null });
  }

  protected showMore(): void {
    this.pages.update((count) => count + 1);
  }

  protected reload(): void {
    this.rankRows.reload();
    this.detailRows.reload();
  }
}
