import { exclude, tstzRange } from 'drizzle-exclude';
import { integer, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

/** Hot-desk reservations in a coworking space: one member per desk at a time. */
export const deskReservations = pgTable('desk_reservations', {
  id: serial().primaryKey(),
  deskId: integer().notNull(),
  member: text().notNull(),
  startsAt: timestamp({ withTimezone: true }).notNull(),
  endsAt: timestamp({ withTimezone: true }).notNull(),
});

export const oneMemberPerDesk = exclude(deskReservations, {
  using: 'gist',
  with: [
    [deskReservations.deskId, '='],
    [tstzRange(deskReservations.startsAt, deskReservations.endsAt), '&&'],
  ],
});
