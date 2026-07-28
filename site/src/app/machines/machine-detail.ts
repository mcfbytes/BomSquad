import { Component, input } from '@angular/core';

import { CoverageBadge } from '../shared/coverage-badge';
import { PlaceholderView } from '../shared/placeholder-view';

/**
 * Machine detail (PLAN §5 view 5), permalink `/machine/:machineId` — e.g.
 * `/machine/outrun`. Built for real by T7.5.
 *
 * The empty BOM table below is deliberate. It is the theme's proof that the
 * data zone stays plain: real column headers, real table styling, zero
 * decoration, and one honest empty row instead of invented chips.
 */
@Component({
  selector: 'app-machine-detail',
  imports: [PlaceholderView, CoverageBadge],
  template: `
    <app-placeholder-view
      task="T7.5"
      heading="Machine"
      [entityId]="machineId()"
      summary="One board, its full bill of materials, and how much of that BOM the open-source FPGA
               world has already covered."
      [willShow]="willShow"
    >
      <section class="bom" aria-labelledby="bom-heading">
        <div class="bom__head">
          <h2 id="bom-heading">Bill of materials</h2>
          <app-coverage-badge />
        </div>
        <div class="table-scroll">
          <table>
            <caption>
              Chip rows link to their implementations; uncovered rows get a red missing badge.
            </caption>
            <thead>
              <tr>
                <th scope="col">Socket</th>
                <th scope="col">Chip</th>
                <th scope="col">Function</th>
                <th scope="col">Clock</th>
                <th scope="col">Qty</th>
                <th scope="col">Implementation</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td colspan="6" class="bom__empty">
                  No BOM loaded. T7.2 opens the database, T7.5 fills this table.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </app-placeholder-view>
  `,
  styles: `
    .bom {
      margin-top: 2.5rem;
    }

    .bom__head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.75rem 1rem;
      margin-bottom: 1rem;
    }

    .bom__head h2 {
      margin-bottom: 0;
    }

    .bom__empty {
      color: var(--muted);
      font-style: italic;
    }
  `,
})
export class MachineDetail {
  readonly machineId = input.required<string>();

  protected readonly willShow = [
    'The full BOM table — one row per socket, with quantity and clock',
    'Per-row implementation links, or a red "missing" badge',
    'A link to the MAME driver and to any existing cores',
  ];
}
