import { Component } from '@angular/core';

import { PlaceholderView } from '../shared/placeholder-view';

/**
 * The Prospector (PLAN §5 view 7) — the flagship. Built for real by T7.7,
 * which is also the task that gets the polish budget.
 */
@Component({
  selector: 'app-prospector',
  imports: [PlaceholderView],
  template: `
    <app-placeholder-view
      task="T7.7"
      heading="The Prospector"
      summary="Boards that nobody has cored yet, ranked by how much of their BOM already exists as
               open HDL. The shortest path from a shelf of silicon to a working core."
      [willShow]="willShow"
    />
  `,
})
export class Prospector {
  protected readonly willShow = [
    'Core-less boards ranked by coverage, highest first',
    'What is missing, inline on every row',
    'Filters for target platform, kind and manufacturer — reflected in the URL',
    'An expandable score breakdown per board, matching the T6.3 scoring data',
  ];
}
