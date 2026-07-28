import { Component } from '@angular/core';

import { PlaceholderView } from '../shared/placeholder-view';

/**
 * Index for the platform-family pages (PLAN §5 view 6). Built for real by T7.6.
 *
 * PLAN §5 only names the family *detail* page; this index exists because the
 * masthead needs somewhere to point and because T7.6's cross-links need a
 * parent. `system` rather than `family` is the schema's own name for the
 * entity (`schemas/schema.sql` → `CREATE TABLE system`).
 */
@Component({
  selector: 'app-system-browser',
  imports: [PlaceholderView],
  template: `
    <app-placeholder-view
      task="T7.6"
      heading="Systems"
      summary="The system16.com dimension: platform families such as Sega System 16B, where one
               shared chipset carries a whole catalogue of machines."
      [willShow]="willShow"
    />
  `,
})
export class SystemBrowser {
  protected readonly willShow = [
    'Every platform family, by manufacturer and kind',
    'Family-level coverage at a glance',
    'Links through to each family page',
  ];
}
