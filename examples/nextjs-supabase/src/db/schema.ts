import { exclude, tstzRange } from 'drizzle-exclude';
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const bookings = pgTable('bookings', {
  id: uuid().defaultRandom().primaryKey(),
  room: text().notNull(),
  guest: text().notNull(),
  startsAt: timestamp({ withTimezone: true }).notNull(),
  endsAt: timestamp({ withTimezone: true }).notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/** No two bookings for the same room may overlap. PostgreSQL enforces it, so it holds under concurrency. */
export const bookingsNoOverlap = exclude(bookings, {
  name: 'bookings_no_overlap',
  using: 'gist',
  with: [
    [bookings.room, '='],
    [tstzRange(bookings.startsAt, bookings.endsAt), '&&'],
  ],
});
