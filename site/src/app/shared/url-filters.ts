import { inject } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';

/**
 * Filters that live in the URL, which is what makes a filtered view shareable.
 *
 * Reading is already solved: `withComponentInputBinding()` (app.config.ts) binds
 * every query parameter to a component `input()`, so a view declares
 * `readonly platform = input('')` and gets `?platform=…` for free — including on a
 * cold load of a pasted link, which is T7.7's acceptance criterion ("deep links
 * reproduce the exact filtered view").
 *
 * This is the writing half. Setting a key to `null` **removes** it, so the URL
 * only ever carries the filters that are actually narrowing something and a reset
 * leaves a clean `/prospector` rather than a trail of empty parameters.
 *
 * `replaceUrl` because a filter is not a page: typing four characters into a text
 * filter should not cost four presses of the Back button to escape.
 */
export type QueryParamPatch = Readonly<Record<string, string | null>>;

export function queryParamWriter(): (patch: QueryParamPatch) => void {
  const router = inject(Router);
  const route = inject(ActivatedRoute);

  return (patch) => {
    void router.navigate([], {
      relativeTo: route,
      queryParams: patch,
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  };
}

/** `''` and `undefined` both mean "not filtering", and neither belongs in the URL. */
export function paramValue(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The `transform` every query-parameter `input()` on this site uses.
 *
 * `withComponentInputBinding()` writes `undefined` into an input whose parameter is
 * absent from the URL — it *overwrites* the declared default rather than leaving it in
 * place — so `input('')` reads back as `undefined` on `/prospector` and every
 * `.trim()` downstream throws. Declaring the transform makes the absent case the empty
 * string at the boundary, once, instead of at forty call sites.
 *
 * `input()` has to be called directly in a field initializer for the compiler to see it,
 * which is why this is a bare function rather than a wrapper around `input()`.
 */
export function param(value: string | undefined): string {
  return value ?? '';
}

/** A `<select>` or `<input>` event's current value, without an `any` in sight. */
export function controlValue(event: Event): string {
  const target = event.target;
  if (target instanceof HTMLSelectElement || target instanceof HTMLInputElement) {
    return target.value;
  }
  return '';
}

/** Case-insensitive substring match used by every browser's free-text filter. */
export function matchesText(needle: string, ...haystack: readonly (string | null)[]): boolean {
  const term = needle.trim().toLowerCase();
  if (term === '') {
    return true;
  }
  return haystack.some((value) => value?.toLowerCase().includes(term) === true);
}
