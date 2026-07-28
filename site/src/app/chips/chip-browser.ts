import { Component } from '@angular/core';

import { PlaceholderView } from '../shared/placeholder-view';

/** Chip browser (PLAN §5 view 2). Built for real by T7.4. */
@Component({
  selector: 'app-chip-browser',
  imports: [PlaceholderView],
  template: `
    <app-placeholder-view
      task="T7.4"
      heading="Chips"
      summary="Every chip in the catalogue, filterable by what it does, who made it, and whether
               anyone has implemented it in HDL yet."
      [willShow]="willShow"
    />
  `,
})
export class ChipBrowser {
  protected readonly willShow = [
    'Filter by function taxonomy, manufacturer and implemented-status',
    'Sort by "used by N machines"',
    'A row per chip, linking to its detail page',
  ];
}
