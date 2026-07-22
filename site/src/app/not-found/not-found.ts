import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-not-found',
  imports: [RouterLink],
  template: `
    <h1>Not found</h1>
    <p>That page doesn't exist (yet).</p>
    <p><a routerLink="/">Back to the dashboard</a></p>
  `,
})
export class NotFound {}
