import { Component } from '@angular/core';

import { PlaceholderView } from '../shared/placeholder-view';

/** Machine / board browser (PLAN §5 view 4). Built for real by T7.5. */
@Component({
  selector: 'app-machine-browser',
  imports: [PlaceholderView],
  template: `
    <app-placeholder-view
      task="T7.5"
      heading="Machines"
      summary="Every arcade board, console and handheld tracked here, filterable down to the ones
               worth your weekend."
      [willShow]="willShow"
    />
  `,
})
export class MachineBrowser {
  protected readonly willShow = [
    'Filter by kind, manufacturer, year range and platform family',
    'Filter by coverage percentage and by whether a core already exists',
    'A coverage badge per row, consistent with the T6.2 coverage views',
  ];
}
