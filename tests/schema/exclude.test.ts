import { sql } from 'drizzle-orm';
import { boolean, pgSchema, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { exclude, ExclusionConstraint } from '../../src/index.js';

const bookings = pgTable('bookings', {
  id: uuid().defaultRandom().primaryKey(),
  roomId: uuid().notNull(),
  startsAt: timestamp({ withTimezone: true }).notNull(),
  endsAt: timestamp({ withTimezone: true }).notNull(),
  cancelled: boolean().notNull().default(false),
});

const rooms = pgTable('rooms', {
  id: uuid().primaryKey(),
});

// Same table name in another schema: the types can't tell it apart, the runtime check can.
const archivedBookings = pgSchema('archive').table('bookings', {
  roomId: uuid().notNull(),
});

const during = sql`tstzrange(${bookings.startsAt}, ${bookings.endsAt}, '[)')`;

describe('exclude()', () => {
  it('keeps the table and the configuration it was given', () => {
    const where = sql`not ${bookings.cancelled}`;
    const constraint = exclude(bookings, {
      name: 'bookings_no_overlap',
      using: 'gist',
      with: [
        [bookings.roomId, '='],
        [during, '&&'],
      ],
      where,
      deferrable: 'deferred',
    });

    expect(constraint).toBeInstanceOf(ExclusionConstraint);
    expect(constraint.table).toBe(bookings);
    expect(constraint.config.name).toBe('bookings_no_overlap');
    expect(constraint.config.using).toBe('gist');
    expect(constraint.config.with[0][0]).toBe(bookings.roomId);
    expect(constraint.config.with[0][1]).toBe('=');
    expect(constraint.config.with[1]?.[0]).toBe(during);
    expect(constraint.config.with[1]?.[1]).toBe('&&');
    expect(constraint.config.where).toBe(where);
    expect(constraint.config.deferrable).toBe('deferred');
  });

  it('leaves optional settings unset', () => {
    const constraint = exclude(bookings, { using: 'gist', with: [[during, '&&']] });

    expect(constraint.config.name).toBeUndefined();
    expect(constraint.config.where).toBeUndefined();
    expect(constraint.config.deferrable).toBeUndefined();
  });

  describe('throws on configuration that cannot describe a constraint', () => {
    it('rejects a column from another table', () => {
      expect(() =>
        exclude(bookings, {
          using: 'gist',
          // @ts-expect-error rooms.id belongs to a different table
          with: [[rooms.id, '=']],
        }),
      ).toThrow('uses column "id" from table "rooms". Every column must belong to "bookings"');
    });

    it('rejects a same-named table from another schema', () => {
      expect(() => exclude(bookings, { using: 'gist', with: [[archivedBookings.roomId, '=']] })).toThrow(
        'Every column must belong to "bookings"',
      );
    });

    it('rejects an empty `with` list', () => {
      expect(() =>
        exclude(bookings, {
          using: 'gist',
          // @ts-expect-error `with` needs at least one pair
          with: [],
        }),
      ).toThrow('`with` needs at least one');
    });

    it('rejects index methods that cannot back an exclusion constraint', () => {
      expect(() =>
        exclude(bookings, {
          // @ts-expect-error GIN has no per-row lookups
          using: 'gin',
          with: [[during, '&&']],
        }),
      ).toThrow(`index method "gin" can't back an exclusion constraint`);
    });

    it('rejects a blank operator', () => {
      expect(() => exclude(bookings, { using: 'gist', with: [[bookings.roomId, ' ']] })).toThrow(
        '`with[0]` needs an operator',
      );
    });

    it('rejects names PostgreSQL would truncate', () => {
      expect(() => exclude(bookings, { name: 'x'.repeat(64), using: 'gist', with: [[during, '&&']] })).toThrow(
        'is 64 bytes',
      );
    });

    it('rejects a value that is not a pgTable', () => {
      // @ts-expect-error the first argument must be a pgTable
      expect(() => exclude({}, { using: 'gist', with: [[during, '&&']] })).toThrow('expects a Drizzle table');
    });

    it('rejects an unknown deferrable mode', () => {
      expect(() =>
        exclude(bookings, {
          using: 'gist',
          with: [[during, '&&']],
          // @ts-expect-error only 'immediate' and 'deferred' exist
          deferrable: 'later',
        }),
      ).toThrow('`deferrable` must be');
    });
  });

  it('is typed to its table', () => {
    const constraint = exclude(bookings, { using: 'gist', with: [[bookings.roomId, '=']] });

    expectTypeOf(constraint).toEqualTypeOf<ExclusionConstraint<typeof bookings>>();
    expectTypeOf(constraint.table).toEqualTypeOf<typeof bookings>();
  });
});
