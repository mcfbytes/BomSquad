import { Component, computed, input } from '@angular/core';

export type CoverageTone = 'ok' | 'warn' | 'bad' | 'unknown';

/** Percentage at or above which coverage reads as "ready". */
const OK_THRESHOLD = 80;
/** Percentage at or above which coverage reads as "in progress". */
const WARN_THRESHOLD = 50;

/**
 * The `9/11 chips · 82%` element from PLAN §5, rendered as an arcade sprite.
 *
 * One component so the badge looks identical on every view that shows coverage
 * (T7.4–T7.7 all consume it). Colour is never the only signal — the counts and
 * the percentage carry the same information as text.
 *
 * Passing `null` counts is a first-class state, not an error: it renders an
 * honest "no data" badge instead of inventing a number.
 */
@Component({
  selector: 'app-coverage-badge',
  template: `
    <span class="badge" [attr.data-tone]="tone()" [attr.data-size]="size()">
      <span class="sr-only">{{ label() }}</span>
      <span class="badge__counts" aria-hidden="true">{{ countsText() }}</span>
      <span class="badge__sep" aria-hidden="true">·</span>
      <span class="badge__percent" aria-hidden="true">{{ percentText() }}</span>
    </span>
  `,
  styles: `
    :host {
      display: inline-block;
    }

    .badge {
      display: inline-flex;
      align-items: baseline;
      gap: 0.4em;
      padding: 0.3em 0.55em;
      /* Pixel face at 16px — the floor at which one font pixel is a whole
         device pixel at DPR 1. See _typography.scss. */
      font-family: var(--font-display);
      font-size: var(--display-sm);
      line-height: 1.4;
      letter-spacing: 0;
      text-transform: uppercase;
      white-space: nowrap;
      color: var(--accent-ink);
      background: var(--muted);
      border-radius: var(--radius);
      box-shadow: var(--shadow-pixel-sm);
      -webkit-font-smoothing: none;
    }

    .badge[data-tone='ok'] {
      background: var(--ok);
    }

    .badge[data-tone='warn'] {
      background: var(--warn);
    }

    .badge[data-tone='bad'] {
      background: var(--bad);
    }

    /* Table-density variant. Same colours and the same text, but the body sans
       at 12px rather than the pixel face: a 16px bitmap badge on every row of a
       40-row BOM is a sticker album, and the pixel face cannot legally go below
       16px (it lands off its 8-unit grid and drops strokes). Decoration belongs
       on chrome; inside a table the badge is data, so it reads as data. */
    .badge[data-size='sm'] {
      padding: 0.2em 0.45em;
      font-family: var(--font-body);
      font-size: var(--label-sm);
      font-weight: 700;
      letter-spacing: 0.06em;
      box-shadow: none;
      -webkit-font-smoothing: antialiased;
    }

    .badge__sep {
      opacity: 0.7;
    }
  `,
})
export class CoverageBadge {
  /** Chips (or whatever `unit` names) that have an implementation. */
  readonly covered = input<number | null>(null);
  /** Total in the bill of materials. `null` or `0` means "not known yet". */
  readonly total = input<number | null>(null);
  readonly unit = input('chips');
  readonly size = input<'md' | 'sm'>('md');

  readonly percent = computed<number | null>(() => {
    const covered = this.covered();
    const total = this.total();
    if (covered === null || total === null || total <= 0) {
      return null;
    }
    return Math.round((covered / total) * 100);
  });

  readonly tone = computed<CoverageTone>(() => {
    const percent = this.percent();
    if (percent === null) {
      return 'unknown';
    }
    if (percent >= OK_THRESHOLD) {
      return 'ok';
    }
    return percent >= WARN_THRESHOLD ? 'warn' : 'bad';
  });

  readonly countsText = computed(() => {
    const covered = this.covered();
    const total = this.total();
    if (covered === null || total === null) {
      return `—/— ${this.unit()}`;
    }
    return `${covered}/${total} ${this.unit()}`;
  });

  readonly percentText = computed(() => {
    const percent = this.percent();
    return percent === null ? '—%' : `${percent}%`;
  });

  readonly label = computed(() => {
    const percent = this.percent();
    if (percent === null) {
      return `Coverage not known yet — no ${this.unit()} data loaded.`;
    }
    return `Coverage: ${this.covered()} of ${this.total()} ${this.unit()}, ${percent} percent.`;
  });
}
