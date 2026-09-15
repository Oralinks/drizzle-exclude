// Expected SQL is written by hand from the PostgreSQL docs' EXCLUDE grammar and examples
// (create_table.sgml, rangetypes.sgml), never copied from this package's output.
import { sql } from 'drizzle-orm';
import { PgDialect, pgTable, text } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { exclude, exclusionConstraintSql, tstzRange } from '../../src/index.js';
import { archivedBookings, bookings, reservation, roomReservation, tsrange } from './fixtures.js';

describe('exclusionConstraintSql()', () => {
  it('renders a range-only exclusion (docs: EXCLUDE USING GIST (during WITH &&))', () => {
    const constraint = exclude(reservation, { using: 'gist', with: [[reservation.during, '&&']] });

    expect(exclusionConstraintSql(constraint)).toBe(
      'ALTER TABLE "reservation" ADD CONSTRAINT "reservation_during_excl" EXCLUDE USING gist ("during" WITH &&);',
    );
  });

  it('renders equality plus range, needing btree_gist (docs: EXCLUDE USING GIST (room WITH =, during WITH &&))', () => {
    const constraint = exclude(roomReservation, {
      using: 'gist',
      with: [
        [roomReservation.room, '='],
        [roomReservation.during, '&&'],
      ],
    });

    // PostgreSQL's own default name for this constraint is room_reservation_room_during_excl too.
    expect(exclusionConstraintSql(constraint)).toBe(
      'ALTER TABLE "room_reservation" ADD CONSTRAINT "room_reservation_room_during_excl" EXCLUDE USING gist ("room" WITH =, "during" WITH &&);',
    );
  });

  it('renders a range expression and a partial WHERE, applying casing', () => {
    const constraint = exclude(bookings, {
      using: 'gist',
      with: [
        [bookings.roomId, '='],
        [tstzRange(bookings.startsAt, bookings.endsAt), '&&'],
      ],
      where: sql`not ${bookings.cancelled}`,
    });

    expect(exclusionConstraintSql(constraint, { casing: 'snake_case' })).toBe(
      `ALTER TABLE "bookings" ADD CONSTRAINT "bookings_room_id_starts_at_ends_at_excl" EXCLUDE USING gist ("room_id" WITH =, (tstzrange("starts_at", "ends_at", '[)')) WITH &&) WHERE (not "cancelled");`,
    );
  });

  it('uses the property names as column names without casing', () => {
    const constraint = exclude(bookings, { using: 'gist', with: [[bookings.roomId, '=']] });

    expect(exclusionConstraintSql(constraint)).toBe(
      'ALTER TABLE "bookings" ADD CONSTRAINT "bookings_roomId_excl" EXCLUDE USING gist ("roomId" WITH =);',
    );
  });

  it('renders a custom name, a schema-qualified table and DEFERRABLE INITIALLY DEFERRED', () => {
    const constraint = exclude(archivedBookings, {
      name: 'bookings_no_overlap',
      using: 'gist',
      with: [
        [archivedBookings.roomId, '='],
        [tstzRange(archivedBookings.startsAt, archivedBookings.endsAt), '&&'],
      ],
      deferrable: 'deferred',
    });

    expect(exclusionConstraintSql(constraint, { casing: 'snake_case' })).toBe(
      `ALTER TABLE "archive"."bookings" ADD CONSTRAINT "bookings_no_overlap" EXCLUDE USING gist ("room_id" WITH =, (tstzrange("starts_at", "ends_at", '[)')) WITH &&) DEFERRABLE INITIALLY DEFERRED;`,
    );
  });

  it('renders DEFERRABLE INITIALLY IMMEDIATE', () => {
    const constraint = exclude(reservation, {
      using: 'gist',
      with: [[reservation.during, '&&']],
      deferrable: 'immediate',
    });

    expect(exclusionConstraintSql(constraint)).toBe(
      'ALTER TABLE "reservation" ADD CONSTRAINT "reservation_during_excl" EXCLUDE USING gist ("during" WITH &&) DEFERRABLE INITIALLY IMMEDIATE;',
    );
  });

  it("inlines parameters, escaping quotes, without changing the caller's sql", () => {
    const where = sql`${bookings.status} <> ${"it's cancelled"}`;
    const constraint = exclude(bookings, { name: 'bookings_active', using: 'gist', with: [[bookings.roomId, '=']], where });

    expect(exclusionConstraintSql(constraint, { casing: 'snake_case' })).toBe(
      `ALTER TABLE "bookings" ADD CONSTRAINT "bookings_active" EXCLUDE USING gist ("room_id" WITH =) WHERE ("status" <> 'it''s cancelled');`,
    );
    expect(new PgDialect().sqlToQuery(where).params).toEqual(["it's cancelled"]);
  });

  it('counts columns inside sql expressions for the default name, once each', () => {
    const constraint = exclude(roomReservation, {
      using: 'gist',
      with: [
        [sql`lower(${roomReservation.room})`, '='],
        [roomReservation.during, '&&'],
        [roomReservation.room, '<>'],
      ],
    });

    expect(exclusionConstraintSql(constraint)).toBe(
      'ALTER TABLE "room_reservation" ADD CONSTRAINT "room_reservation_room_during_excl" EXCLUDE USING gist ((lower("room")) WITH =, "during" WITH &&, "room" WITH <>);',
    );
  });

  it('throws when the default name would be over 63 bytes', () => {
    const longTable = pgTable('a_table_with_a_rather_long_name', {
      aColumnWithAQuiteLongNameToo: text(),
      during: tsrange('during'),
    });
    const constraint = exclude(longTable, {
      using: 'gist',
      with: [
        [longTable.aColumnWithAQuiteLongNameToo, '='],
        [longTable.during, '&&'],
      ],
    });

    expect(() => exclusionConstraintSql(constraint, { casing: 'snake_case' })).toThrow('Pass a shorter `name` to exclude()');
  });
});

describe('operator validation in exclude()', () => {
  it('accepts OPERATOR(schema.op)', () => {
    const constraint = exclude(roomReservation, { using: 'gist', with: [[roomReservation.room, 'OPERATOR(pg_catalog.=)']] });

    expect(exclusionConstraintSql(constraint)).toBe(
      'ALTER TABLE "room_reservation" ADD CONSTRAINT "room_reservation_room_excl" EXCLUDE USING gist ("room" WITH OPERATOR(pg_catalog.=));',
    );
  });

  it('rejects anything that is not PostgreSQL operator syntax', () => {
    expect(() => exclude(roomReservation, { using: 'gist', with: [[roomReservation.room, '=); DROP TABLE x; --']] })).toThrow(
      '`with[0]` needs an operator',
    );
  });
});
