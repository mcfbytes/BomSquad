import { Component } from '@angular/core';

import { PlaceholderView } from '../shared/placeholder-view';

/** Implementation browser (PLAN §5 view 8). Built for real by T7.8. */
@Component({
  selector: 'app-implementation-browser',
  imports: [PlaceholderView],
  template: `
    <app-placeholder-view
      task="T7.8"
      heading="Implementations"
      summary="Every known open-source HDL implementation of a catalogued chip, and who is already
               using it."
      [willShow]="willShow"
    />
  `,
})
export class ImplementationBrowser {
  protected readonly willShow = [
    'Filter by language, license, accuracy level and author',
    'Outbound links to the source repositories',
    'The chips each implementation covers, and the cores consuming it',
  ];
}
