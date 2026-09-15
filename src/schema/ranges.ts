import { entityKind, getTableName, is, type SQL, sql, type SQLWrapper } from 'drizzle-orm';
import {
  type AnyPgColumn,
  PgColumn,
  PgDate,
  PgDateString,
  PgInteger,
  PgSerial,
  PgTimestamp,
  PgTimestampString,
} from 'drizzle-orm/pg-core';
import { fail } from './fail.js';

/**
 * Which ends of a range are included. `[` and `]` include the bound; `(` and `)` exclude it.
 *
 * @example
 * ```ts
 * // Half-open: a 10:00–11:00 booking and an 11:00–12:00 booking don't overlap.
 * const bounds: RangeBounds = '[)';
 * ```
 */
export type RangeBounds = '[)' | '[]' | '(]' | '()';

/**
 * Options shared by {@link tstzRange}, {@link dateRange} and {@link int4Range}.
 *
 * @example
 * ```ts
 * const inclusive: RangeOptions = { bounds: '[]' };
 * ```
 */
export interface RangeOptions {
  /** Defaults to `'[)'`, so back-to-back ranges don't overlap (D2). */
  bounds?: RangeBounds;
}

/**
 * The PostgreSQL range constructor a {@link RangeExpression} calls.
 *
 * @example
 * ```ts
 * tstzRange(bookings.startsAt, bookings.endsAt).fn; // 'tstzrange'
 * ```
 */
export type RangeFunction = 'tstzrange' | 'daterange' | 'int4range';

type TimestampColumnType = 'PgTimestamp' | 'PgTimestampString';
type DateColumnType = 'PgDate' | 'PgDateString';
type Int4ColumnType = 'PgInteger' | 'PgSerial';

/**
 * A range built from two columns of one table, such as `tstzrange(starts_at, ends_at, '[)')`.
 * It works anywhere Drizzle accepts `sql`, and records its columns so {@link exclude} can
 * check they belong to the constrained table.
 *
 * @example
 * ```ts
 * const during = tstzRange(bookings.startsAt, bookings.endsAt);
 * during.columns; // [bookings.startsAt, bookings.endsAt]
 * during.bounds; // '[)'
 * ```
 */
export class RangeExpression<TTableName extends string = string> implements SQLWrapper {
  static readonly [entityKind]: string = 'DrizzleExcludeRangeExpression';

  declare readonly _: { readonly tableName: TTableName };

  constructor(
    readonly fn: RangeFunction,
    readonly lower: AnyPgColumn,
    readonly upper: AnyPgColumn,
    readonly bounds: RangeBounds,
  ) {}

  /** The lower and upper bound columns, in order. */
  get columns(): readonly [AnyPgColumn, AnyPgColumn] {
    return [this.lower, this.upper];
  }

  getSQL(): SQL {
    // Bounds are one of four validated literals, so they're inlined: DDL can't take query parameters.
    return sql`${sql.raw(this.fn)}(${this.lower}, ${this.upper}, ${sql.raw(`'${this.bounds}'`)})`;
  }
}

const BOUNDS: readonly string[] = ['[)', '[]', '(]', '()'] satisfies RangeBounds[];

type ColumnCheck = (column: PgColumn) => string | undefined;

function range<TTableName extends string>(
  fn: RangeFunction,
  helper: string,
  lower: AnyPgColumn,
  upper: AnyPgColumn,
  options: RangeOptions | undefined,
  check: ColumnCheck,
): RangeExpression<TTableName> {
  for (const [position, column] of [
    ['lower', lower],
    ['upper', upper],
  ] as const) {
    if (!is(column, PgColumn)) {
      fail(`${helper}(): the ${position} bound must be a Drizzle column.`);
    }
    const problem = check(column);
    if (problem !== undefined) {
      fail(`${helper}(): ${problem}`);
    }
  }

  if (lower.table !== upper.table) {
    fail(
      `${helper}(): the lower bound "${lower.name}" is from table "${getTableName(lower.table)}" but the upper bound "${upper.name}" is from "${getTableName(upper.table)}". Both bounds must come from the same table.`,
    );
  }

  const bounds = options?.bounds ?? '[)';
  if (!BOUNDS.includes(bounds)) {
    fail(`${helper}(): bounds must be '[)', '[]', '(]' or '()', not ${JSON.stringify(bounds)}.`);
  }

  return new RangeExpression<TTableName>(fn, lower, upper, bounds);
}

const timestampWithTimeZone: ColumnCheck = (column) => {
  if (!(is(column, PgTimestamp) || is(column, PgTimestampString))) {
    return `column "${column.name}" is ${column.getSQLType()}, not a timestamp. Use timestamp({ withTimezone: true }) columns.`;
  }
  if (!column.withTimezone) {
    return `column "${column.name}" is a timestamp without time zone. Declare it as timestamp({ withTimezone: true }): times without a zone are ambiguous across time zones and DST changes (D3).`;
  }
  return undefined;
};

const dateColumn: ColumnCheck = (column) =>
  is(column, PgDate) || is(column, PgDateString)
    ? undefined
    : `column "${column.name}" is ${column.getSQLType()}, not a date. Use date() columns.`;

const int4Column: ColumnCheck = (column) =>
  is(column, PgInteger) || is(column, PgSerial)
    ? undefined
    : `column "${column.name}" is ${column.getSQLType()}, not an integer. Use integer() or serial() columns.`;

/**
 * A `tstzrange` over two timestamp-with-time-zone columns of one table.
 *
 * Only timestamp columns compile. A timestamp without a time zone throws immediately,
 * because Drizzle's types can't tell the two apart (D20).
 *
 * @example
 * ```ts
 * import { exclude, tstzRange } from 'drizzle-exclude';
 *
 * export const bookingsNoOverlap = exclude(bookings, {
 *   using: 'gist',
 *   with: [
 *     [bookings.roomId, '='],
 *     [tstzRange(bookings.startsAt, bookings.endsAt), '&&'], // tstzrange(starts_at, ends_at, '[)')
 *   ],
 * });
 * ```
 */
export function tstzRange<TLower extends AnyPgColumn<{ columnType: TimestampColumnType }>>(
  lower: TLower,
  upper: AnyPgColumn<{ tableName: TLower['_']['tableName']; columnType: TimestampColumnType }>,
  options?: RangeOptions,
): RangeExpression<TLower['_']['tableName']> {
  return range('tstzrange', 'tstzRange', lower, upper, options, timestampWithTimeZone);
}

/**
 * A `daterange` over two date columns of one table.
 *
 * @example
 * ```ts
 * import { dateRange, exclude } from 'drizzle-exclude';
 *
 * export const staysNoOverlap = exclude(stays, {
 *   using: 'gist',
 *   with: [
 *     [stays.roomId, '='],
 *     [dateRange(stays.checkIn, stays.checkOut), '&&'], // daterange(check_in, check_out, '[)')
 *   ],
 * });
 * ```
 */
export function dateRange<TLower extends AnyPgColumn<{ columnType: DateColumnType }>>(
  lower: TLower,
  upper: AnyPgColumn<{ tableName: TLower['_']['tableName']; columnType: DateColumnType }>,
  options?: RangeOptions,
): RangeExpression<TLower['_']['tableName']> {
  return range('daterange', 'dateRange', lower, upper, options, dateColumn);
}

/**
 * An `int4range` over two integer columns of one table, such as seat or slot numbers.
 *
 * @example
 * ```ts
 * import { exclude, int4Range } from 'drizzle-exclude';
 *
 * export const seatsNoOverlap = exclude(seatHolds, {
 *   using: 'gist',
 *   with: [
 *     [seatHolds.showId, '='],
 *     [int4Range(seatHolds.firstSeat, seatHolds.lastSeat, { bounds: '[]' }), '&&'],
 *   ],
 * });
 * ```
 */
export function int4Range<TLower extends AnyPgColumn<{ columnType: Int4ColumnType }>>(
  lower: TLower,
  upper: AnyPgColumn<{ tableName: TLower['_']['tableName']; columnType: Int4ColumnType }>,
  options?: RangeOptions,
): RangeExpression<TLower['_']['tableName']> {
  return range('int4range', 'int4Range', lower, upper, options, int4Column);
}
