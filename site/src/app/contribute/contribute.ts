import { Component } from '@angular/core';

import { PlaceholderView } from '../shared/placeholder-view';

interface DocLink {
  readonly href: string;
  readonly label: string;
  readonly blurb: string;
}

const REPO = 'https://github.com/mcfbytes/BomSquad';

/**
 * Contribute page (PLAN §5 view 9). Built out by T8.1–T8.4, which write
 * CONTRIBUTING.md and the issue templates this page will point at.
 *
 * The links below are the ones that exist in the repository today. Nothing is
 * linked speculatively — a dead link on the "how to help" page is the worst
 * possible first impression.
 */
@Component({
  selector: 'app-contribute',
  imports: [PlaceholderView],
  template: `
    <app-placeholder-view
      task="T8.1"
      heading="Contribute"
      summary="The dataset is only as good as the people checking it. Corrections are curated rows,
               never hand-edits to generated files."
      [willShow]="willShow"
    >
      <section class="docs" aria-labelledby="docs-heading">
        <h2 id="docs-heading">Specifications that already exist</h2>
        <ul class="docs__list">
          @for (doc of docs; track doc.href) {
            <li>
              <a [href]="doc.href" rel="noopener">{{ doc.label }}</a>
              <span class="docs__blurb">{{ doc.blurb }}</span>
            </li>
          }
        </ul>
      </section>
    </app-placeholder-view>
  `,
  styles: `
    .docs {
      margin-top: 2.5rem;
      max-width: 70ch;
    }

    .docs__list {
      list-style: none;
      padding-left: 0;
    }

    .docs__list li {
      padding: 0.5rem 0;
      border-bottom: 1px solid var(--border);
    }

    .docs__blurb {
      display: block;
      color: var(--muted);
      font-size: 0.9375rem;
    }
  `,
})
export class Contribute {
  protected readonly willShow = [
    'How to add a chip, a BOM row or an implementation',
    'The correction tables — machine_correction, machine_chip_correction, machine_system',
    'Issue templates for "chip missing", "BOM wrong" and "implementation to add"',
    'The provenance rule: every curated fact cites a verifiable source',
  ];

  protected readonly docs: readonly DocLink[] = [
    {
      href: `${REPO}/blob/master/docs/data-model.md`,
      label: 'Data model',
      blurb: 'The relational schema, the ID conventions, and the alias mechanism.',
    },
    {
      href: `${REPO}/blob/master/docs/taxonomy.md`,
      label: 'Taxonomy',
      blurb: 'Chip functions, system kinds, and the controlled vocabularies behind the filters.',
    },
    {
      href: `${REPO}/blob/master/docs/coverage.md`,
      label: 'Coverage',
      blurb: 'How a coverage percentage is defined, and what equivalence does to it.',
    },
    {
      href: `${REPO}/blob/master/docs/data-quality.md`,
      label: 'Data quality',
      blurb: 'The validation gates every curated row has to clear before it ships.',
    },
    {
      href: REPO,
      label: 'The repository',
      blurb: 'Issues, pull requests, and the pipeline that builds the database.',
    },
  ];
}
