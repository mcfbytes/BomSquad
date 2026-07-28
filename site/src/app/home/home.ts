import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

/**
 * Home / dashboard (PLAN §5 view 1).
 *
 * The hero is the one place in the app that gets the full arcade treatment —
 * CRT texture, pixel display face, marquee accent. Every headline figure below
 * it is an em dash on purpose: T7.9 queries them from the database, and a
 * plausible-looking placeholder number would be a lie about a dataset that does
 * not exist yet.
 */
@Component({
  selector: 'app-home',
  imports: [RouterLink],
  template: `
    <section class="hero panel crt">
      <div class="hero__inner">
        <p class="eyebrow">Insert coin</p>
        <h1>BOM Squad</h1>
        <p class="hero__lede">
          An open database mapping arcade boards and consoles to their chip bills-of-materials,
          linking those chips to open-source FPGA implementations, and surfacing the boards that are
          ready to become cores but don't have one yet.
        </p>
        <p class="hero__actions">
          <a class="pixel-button" routerLink="/prospector">Open the Prospector</a>
          <a class="pixel-button" routerLink="/machines">Browse machines</a>
        </p>
      </div>
    </section>

    <section class="section" aria-labelledby="stats-heading">
      <h2 id="stats-heading">Headline stats</h2>
      <div class="stats">
        @for (tile of statTiles; track tile) {
          <div class="panel panel--flat stat">
            <span class="stat__value">—</span>
            <span class="stat__label">{{ tile }}</span>
          </div>
        }
      </div>
      <p class="note">
        Every figure above is a placeholder dash. T7.9 queries them live from the shipped database
        and from <code>dist/quality-report.json</code>; nothing here is hardcoded, because nothing
        here is real yet.
      </p>
    </section>
  `,
  styles: `
    :host {
      display: block;
    }

    .hero {
      padding: 2.5rem 1.5rem;
      margin-bottom: 2.5rem;
    }

    .hero__inner {
      max-width: 62ch;
    }

    .hero__lede {
      font-size: 1.0625rem;
      color: var(--fg);
    }

    .hero__actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.75rem;
      margin-bottom: 0;
    }

    .section {
      max-width: 70ch;
    }

    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
      gap: 1rem;
      margin-bottom: 1.25rem;
    }

    .note {
      color: var(--muted);
      font-size: 0.9375rem;
    }
  `,
})
export class Home {
  protected readonly statTiles = [
    'Chips cataloged',
    'Chips implemented',
    'Machines tracked',
    'Cores tracked',
  ] as const;
}
