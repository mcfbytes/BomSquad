import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-not-found',
  imports: [RouterLink],
  template: `
    <div class="panel not-found">
      <p class="eyebrow">Game over</p>
      <h1>Not found</h1>
      <p>That page doesn't exist (yet).</p>
      <p class="not-found__actions">
        <a class="pixel-button" routerLink="/">Continue</a>
      </p>
    </div>
  `,
  styles: `
    .not-found {
      max-width: 48ch;
    }

    .not-found__actions {
      margin-bottom: 0;
    }
  `,
})
export class NotFound {}
