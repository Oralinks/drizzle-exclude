// Keeps README.md honest: the quick start's migration SQL must be exactly what the package renders
// for the quick start's schema. If either changes, this fails.
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { boolean, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { exclude, exclusionMigrationSql, tstzRange } from '../src/index.js';

// Same as README.md, "1. Define the constraint next to your table".
const bookings = pgTable('bookings', {
  id: uuid().defaultRandom().primaryKey(),
  roomId: uuid().notNull(),
  startsAt: timestamp({ withTimezone: true }).notNull(),
  endsAt: timestamp({ withTimezone: true }).notNull(),
  cancelled: boolean().notNull().default(false),
});

const bookingsNoOverlap = exclude(bookings, {
  using: 'gist',
  with: [
    [bookings.roomId, '='],
    [tstzRange(bookings.startsAt, bookings.endsAt), '&&'],
  ],
  where: sql`not ${bookings.cancelled}`,
});

describe('README.md', () => {
  it("shows the quick start's migration SQL exactly as exclusionMigrationSql() renders it", () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
    const sqlBlock = /```sql\n([\s\S]*?)\n```/.exec(readme)?.[1];

    expect(sqlBlock).toBe(exclusionMigrationSql([bookingsNoOverlap], { casing: 'snake_case' }));
  });
});
