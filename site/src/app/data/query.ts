import {
  type Injector,
  type ResourceRef,
  type Signal,
  computed,
  inject,
  resource,
} from '@angular/core';

import { DatabaseService } from './database';
import type { TableName, TableRowTypes } from './schema-types.generated';
import type { QuerySpec } from './sql';
import type { ViewName, ViewRowTypes } from './view-types.generated';

/**
 * The seam T7.4–T7.9 build on.
 *
 * A view or table row type, by relation name:
 *
 * ```ts
 * const boards = query<RowOf<'v_prospector'>>(() => ({
 *   sql: 'SELECT * FROM v_prospector WHERE platform_id = :platform ORDER BY satisfied_share DESC',
 *   params: { ':platform': this.platform() },
 * }));
 * ```
 *
 * `boards` is a stock Angular `ResourceRef`: `.value()` for the rows, `.isLoading()`,
 * `.error()`, `.status()` and `.reload()`. Nothing bespoke to learn, and the
 * loading and error states a view has to render are the framework's own.
 */
export interface RelationRowTypes extends TableRowTypes, ViewRowTypes {}

/** Every table and view in `schemas/schema.sql`. */
export type RelationName = TableName | ViewName;

/** The row type of a relation, keyed by its name. */
export type RowOf<N extends RelationName> = RelationRowTypes[N];

export interface QueryOptions {
  /** Required when calling from outside an injection context. */
  readonly injector?: Injector;
  /** Shown in Angular DevTools. */
  readonly debugName?: string;
}

/**
 * A reactive SQL query over the in-browser database.
 *
 * `spec` is re-evaluated whenever the signals it reads change, and the statement
 * re-runs. Returning `undefined` means "nothing to ask yet" — the resource stays
 * idle and keeps its empty default rather than running a query with a missing
 * parameter, which is the common case while a route parameter is still resolving.
 *
 * Errors are not swallowed. A failed database download surfaces as the
 * `DatabaseLoadError` that failed it, and a statement the engine rejects — a typo,
 * a view that is not in the shipped schema — surfaces as a `SqlQueryError` carrying
 * SQLite's own message. Both land in `.error()`, which is what `<app-data-status>`
 * renders.
 */
export function query<T>(
  spec: () => QuerySpec | undefined,
  options: QueryOptions = {},
): ResourceRef<readonly T[]> {
  const database = options.injector?.get(DatabaseService) ?? inject(DatabaseService);
  // `QuerySpec | undefined` in the params type is what lets `spec()` say "not yet":
  // `resource` treats an undefined request as idle and never calls the loader.
  return resource<readonly T[], QuerySpec | undefined>({
    params: spec,
    defaultValue: [],
    loader: ({ params }) => database.select<T>(params.sql, params.params),
    ...pick(options, 'injector'),
    ...pick(options, 'debugName'),
  });
}

/** As `query()`, for a statement that yields at most one row. */
export function queryRow<T>(
  spec: () => QuerySpec | undefined,
  options: QueryOptions = {},
): ResourceRef<T | null> {
  const database = options.injector?.get(DatabaseService) ?? inject(DatabaseService);
  return resource<T | null, QuerySpec | undefined>({
    params: spec,
    defaultValue: null,
    loader: ({ params }) => database.selectOne<T>(params.sql, params.params),
    ...pick(options, 'injector'),
    ...pick(options, 'debugName'),
  });
}

/**
 * Every row of one relation, unfiltered.
 *
 * Useful for the small lookup tables the browsers need for their filter controls
 * (`chip_function`, `manufacturer`, `implementation_kind`, `fpga_platform`) and for
 * the one-row quality views. It is deliberately not the way to read `machine` —
 * 9 775 rows through a component is a query that wants a `WHERE`.
 */
export function queryAll<N extends RelationName>(
  relation: N,
  options: QueryOptions & { readonly orderBy?: string } = {},
): ResourceRef<readonly RowOf<N>[]> {
  const order = options.orderBy === undefined ? '' : ` ORDER BY ${options.orderBy}`;
  return query<RowOf<N>>(() => ({ sql: `SELECT * FROM "${relation}"${order}` }), options);
}

/**
 * `true` while a resource has no usable value yet.
 *
 * `isLoading()` alone flickers false for one turn between params changing and the
 * loader starting, which is long enough for a table to flash its empty state.
 */
export function isPending(ref: Pick<ResourceRef<unknown>, 'status'>): Signal<boolean> {
  return computed(() => {
    const status = ref.status();
    return status === 'loading' || status === 'reloading';
  });
}

/**
 * `exactOptionalPropertyTypes` is on, so `{ injector: options.injector }` is not
 * assignable to `{ injector?: Injector }` when the value is `undefined`. Spreading
 * the key only when it is present is the version that type-checks.
 */
function pick<T extends object, K extends keyof T>(source: T, key: K): Partial<Pick<T, K>> {
  return source[key] === undefined ? {} : ({ [key]: source[key] } as Pick<T, K>);
}
