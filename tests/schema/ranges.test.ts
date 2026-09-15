import { date, integer, PgDialect, pgTable, serial, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { dateRange, exclude, int4Range, RangeExpression, tstzRange } from '../../src/index.js';

const bookings = pgTable('bookings', {
  id: uuid().primaryKey(),
  roomId: uuid().notNull(),
  startsAt: timestamp({ withTimezone: true }).notNull(),
  endsAt: timestamp({ withTimezone: true }).notNull(),
  startsAtText: timestamp({ withTimezone: true, mode: 'string' }),
  endsAtText: timestamp({ withTimezone: true, mode: 'string' }),
  naiveStart: timestamp(),
  naiveEnd: timestamp(),
  checkIn: date(),
  checkOut: date({ mode: 'date' }),
  firstSeat: integer(),
  lastSeat: serial(),
  note: text(),
});

const rooms = pgTable('rooms', {
  id: uuid().primaryKey(),
  openedAt: timestamp({ withTimezone: true }),
  closedAt: timestamp({ withTimezone: true }),
});

const dialect = new PgDialect();

describe('tstzRange()', () => {
  it('defaults to half-open bounds and records its columns', () => {
    const during = tstzRange(bookings.startsAt, bookings.endsAt);

    expect(during).toBeInstanceOf(RangeExpression);
    expect(during.fn).toBe('tstzrange');
    expect(during.bounds).toBe('[)');
    expect(during.columns).toEqual([bookings.startsAt, bookings.endsAt]);
    expect(during.columns[0]).toBe(bookings.startsAt);
    expect(during.columns[1]).toBe(bookings.endsAt);
  });

  it('renders SQL with the bounds inlined, not as a parameter', () => {
    const query = dialect.sqlToQuery(tstzRange(bookings.startsAt, bookings.endsAt, { bounds: '[]' }).getSQL());

    expect(query.sql).toBe(`tstzrange("bookings"."startsAt", "bookings"."endsAt", '[]')`);
    expect(query.params).toEqual([]);
  });

  it('accepts timestamps in string mode', () => {
    expect(tstzRange(bookings.startsAtText, bookings.endsAtText).bounds).toBe('[)');
  });

  it('throws for a timestamp without a time zone (D3, D20)', () => {
    // Compiles: Drizzle's types don't record the time zone, so this is caught at runtime.
    expect(() => tstzRange(bookings.naiveStart, bookings.naiveEnd)).toThrow(
      'column "naiveStart" is a timestamp without time zone. Declare it as timestamp({ withTimezone: true })',
    );
  });

  it('rejects columns that are not timestamps', () => {
    // @ts-expect-error text is not a timestamp column
    expect(() => tstzRange(bookings.note, bookings.endsAt)).toThrow('column "note" is text, not a timestamp');
  });

  it('rejects bounds from different tables', () => {
    // @ts-expect-error the upper bound comes from another table
    expect(() => tstzRange(bookings.startsAt, rooms.closedAt)).toThrow('Both bounds must come from the same table');
  });

  it('rejects unknown bounds', () => {
    // @ts-expect-error '[[' is not a bounds literal
    expect(() => tstzRange(bookings.startsAt, bookings.endsAt, { bounds: '[[' })).toThrow(`bounds must be '[)'`);
  });

  it('is typed to its table', () => {
    expectTypeOf(tstzRange(bookings.startsAt, bookings.endsAt)).toEqualTypeOf<RangeExpression<'bookings'>>();
  });
});

describe('dateRange()', () => {
  it('accepts date columns in either mode', () => {
    const stay = dateRange(bookings.checkIn, bookings.checkOut);

    expect(stay.fn).toBe('daterange');
    expect(dialect.sqlToQuery(stay.getSQL()).sql).toBe(`daterange("bookings"."checkIn", "bookings"."checkOut", '[)')`);
  });

  it('rejects columns that are not dates', () => {
    // @ts-expect-error a timestamp is not a date column
    expect(() => dateRange(bookings.startsAt, bookings.checkOut)).toThrow('not a date');
  });
});

describe('int4Range()', () => {
  it('accepts integer and serial columns', () => {
    const seats = int4Range(bookings.firstSeat, bookings.lastSeat, { bounds: '[]' });

    expect(seats.fn).toBe('int4range');
    expect(seats.bounds).toBe('[]');
  });

  it('rejects columns that are not integers', () => {
    // @ts-expect-error text is not an integer column
    expect(() => int4Range(bookings.note, bookings.lastSeat)).toThrow('not an integer');
  });
});

describe('ranges in exclude()', () => {
  it('accepts a range over the same table', () => {
    const during = tstzRange(bookings.startsAt, bookings.endsAt);
    const constraint = exclude(bookings, {
      using: 'gist',
      with: [
        [bookings.roomId, '='],
        [during, '&&'],
      ],
    });

    expect(constraint.config.with[1]?.[0]).toBe(during);
  });

  it('rejects a range over another table', () => {
    expect(() =>
      exclude(bookings, {
        using: 'gist',
        // @ts-expect-error the range is over rooms, not bookings
        with: [[tstzRange(rooms.openedAt, rooms.closedAt), '&&']],
      }),
    ).toThrow('is a range over column "openedAt" from table "rooms"');
  });
});
