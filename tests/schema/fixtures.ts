import { boolean, customType, pgSchema, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** A `tsrange` column. Drizzle has no built-in range column types. */
export const tsrange = customType<{ data: string }>({ dataType: () => 'tsrange' });

// From the PostgreSQL docs, "Constraints on Ranges" (rangetypes.sgml):
//   CREATE TABLE reservation (during tsrange, EXCLUDE USING GIST (during WITH &&));
export const reservation = pgTable('reservation', {
  during: tsrange('during'),
});

// Same section, with btree_gist:
//   CREATE TABLE room_reservation (room text, during tsrange, EXCLUDE USING GIST (room WITH =, during WITH &&));
export const roomReservation = pgTable('room_reservation', {
  room: text('room'),
  during: tsrange('during'),
});

// Column builders can't be shared between tables, so each table gets fresh ones.
const bookingColumns = () => ({
  id: uuid().defaultRandom().primaryKey(),
  roomId: uuid().notNull(),
  startsAt: timestamp({ withTimezone: true }).notNull(),
  endsAt: timestamp({ withTimezone: true }).notNull(),
  cancelled: boolean().notNull().default(false),
  status: text(),
});

/** The package's booking use case, with key-named columns so `casing` matters. */
export const bookings = pgTable('bookings', bookingColumns());
export const holds = pgTable('holds', bookingColumns());
export const archivedBookings = pgSchema('archive').table('bookings', bookingColumns());

/** Hand-written DDL for the tables above, as drizzle-kit would create them with `casing: 'snake_case'`. */
export const createTablesSql = `
  CREATE EXTENSION IF NOT EXISTS btree_gist;
  CREATE SCHEMA archive;

  CREATE TABLE reservation (during tsrange);
  CREATE TABLE room_reservation (room text, during tsrange);
  ${['bookings', 'holds', 'archive.bookings']
    .map(
      (table) => `CREATE TABLE ${table} (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        room_id uuid NOT NULL,
        starts_at timestamptz NOT NULL,
        ends_at timestamptz NOT NULL,
        cancelled boolean NOT NULL DEFAULT false,
        status text
      );`,
    )
    .join('\n')}
`;
