import { Component, input } from '@angular/core';

import { PlaceholderView } from '../shared/placeholder-view';

/**
 * Chip detail (PLAN §5 view 3), permalink `/chip/:chipId` — e.g. `/chip/ym2151`.
 * Built for real by T7.4.
 *
 * `chipId` is bound straight from the route by `withComponentInputBinding()`,
 * so the deep link is already load-bearing: refresh on the deployed site has to
 * come back to this component with the same id (SWA `navigationFallback`).
 */
@Component({
  selector: 'app-chip-detail',
  imports: [PlaceholderView],
  template: `
    <app-placeholder-view
      task="T7.4"
      heading="Chip"
      [entityId]="chipId()"
      summary="Everything known about one part: what it is, who made it, who cloned it, which boards
               used it, and which open implementations cover it."
      [willShow]="willShow"
    />
  `,
})
export class ChipDetail {
  readonly chipId = input.required<string>();

  protected readonly willShow = [
    'Specifications, aliases and datasheet links',
    'Every implementation, with license and accuracy badges',
    'Every machine whose BOM contains this chip',
    'Equivalence notes — the parts this one can stand in for, and vice versa',
  ];
}
