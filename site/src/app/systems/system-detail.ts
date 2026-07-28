import { Component, input } from '@angular/core';

import { PlaceholderView } from '../shared/placeholder-view';

/**
 * Platform family view (PLAN §5 view 6), permalink `/system/:systemId` — e.g.
 * `/system/sega-system16b`. Built for real by T7.6.
 *
 * PLAN §5's example permalink is `/family/…`; `/system/…` is the canonical
 * route because `system` is what the schema calls this entity, and
 * `/family/:systemId` redirects here so the older shape keeps resolving.
 */
@Component({
  selector: 'app-system-detail',
  imports: [PlaceholderView],
  template: `
    <app-placeholder-view
      task="T7.6"
      heading="Platform family"
      [entityId]="systemId()"
      summary="One chipset, every machine built on it, and the coverage the family gets as a whole."
      [willShow]="willShow"
    />
  `,
})
export class SystemDetail {
  readonly systemId = input.required<string>();

  protected readonly willShow = [
    'The shared chipset — the family-level BOM',
    'Every member machine, with its own coverage',
    'Family-level coverage, and the MAME driver rules that define membership',
  ];
}
