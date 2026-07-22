import { Component } from '@angular/core';

@Component({
  selector: 'app-home',
  template: `
    <h1>BOM Squad</h1>
    <p>
      An open database mapping arcade boards and consoles to their chip bills-of-materials, linking
      those chips to open-source FPGA implementations, and surfacing boards that are ready to become
      cores but don't have one yet.
    </p>
    <p class="status">Deployment placeholder — the dataset and Prospector land in later phases.</p>
  `,
  styles: `
    :host {
      display: block;
      max-width: 60ch;
    }
    .status {
      color: var(--muted);
      font-style: italic;
    }
  `,
})
export class Home {}
