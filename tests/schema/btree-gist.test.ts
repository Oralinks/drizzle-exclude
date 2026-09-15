import { sql } from 'drizzle-orm';
import { pgTable, point, text } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { btreeGistSql, exclude, exclusionMigrationSql, needsBtreeGist, tstzRange } from '../../src/index.js';
import { bookings, holds, reservation, roomReservation } from './fixtures.js';

const places = pgTable('places', {
  name: text('name'),
  location: point('location'),
});

const bookingsNoOverlap = exclude(bookings, {
  using: 'gist',
  with: [
    [bookings.roomId, '='],
    [tstzRange(bookings.startsAt, bookings.endsAt), '&&'],
  ],
});

describe('needsBtreeGist()', () => {
  it('is false for ranges alone', () => {
    expect(needsBtreeGist(exclude(reservation, { using: 'gist', with: [[reservation.during, '&&']] }))).toBe(false);
    expect(
      needsBtreeGist(exclude(bookings, { using: 'gist', with: [[tstzRange(bookings.startsAt, bookings.endsAt), '&&']] })),
    ).toBe(false);
  });

  it('is true when a scalar column is compared, as in the docs room_reservation example', () => {
    expect(
      needsBtreeGist(
        exclude(roomReservation, {
          using: 'gist',
          with: [
            [roomReservation.room, '='],
            [roomReservation.during, '&&'],
          ],
        }),
      ),
    ).toBe(true);
    expect(needsBtreeGist(bookingsNoOverlap)).toBe(true);
  });

  it('is false for geometric types PostgreSQL indexes with GiST natively', () => {
    expect(needsBtreeGist(exclude(places, { using: 'gist', with: [[places.location, '~=']] }))).toBe(false);
  });

  it('is true for sql expressions, whose type is unknown', () => {
    expect(needsBtreeGist(exclude(roomReservation, { using: 'gist', with: [[sql`lower(${roomReservation.room})`, '=']] }))).toBe(
      true,
    );
  });

  it('is false for index methods other than gist', () => {
    expect(needsBtreeGist(exclude(roomReservation, { using: 'btree', with: [[roomReservation.room, '=']] }))).toBe(false);
  });
});

describe('btreeGistSql()', () => {
  it('returns the idempotent CREATE EXTENSION statement', () => {
    expect(btreeGistSql()).toBe('CREATE EXTENSION IF NOT EXISTS btree_gist;');
  });
});

describe('exclusionMigrationSql()', () => {
  it("starts with CREATE EXTENSION when a constraint needs btree_gist ('create', the default)", () => {
    expect(exclusionMigrationSql([bookingsNoOverlap], { casing: 'snake_case' })).toBe(
      [
        'CREATE EXTENSION IF NOT EXISTS btree_gist;',
        '--> statement-breakpoint',
        `ALTER TABLE "bookings" ADD CONSTRAINT "bookings_room_id_starts_at_ends_at_excl" EXCLUDE USING gist ("room_id" WITH =, (tstzrange("starts_at", "ends_at", '[)')) WITH &&);`,
      ].join('\n'),
    );
  });

  it('adds nothing for constraints that do not need it', () => {
    expect(exclusionMigrationSql([exclude(reservation, { using: 'gist', with: [[reservation.during, '&&']] })])).toBe(
      'ALTER TABLE "reservation" ADD CONSTRAINT "reservation_during_excl" EXCLUDE USING gist ("during" WITH &&);',
    );
  });

  it('adds the extension once for several constraints, in order', () => {
    const holdsNoOverlap = exclude(holds, { name: 'holds_no_overlap', using: 'gist', with: [[holds.roomId, '=']] });

    expect(exclusionMigrationSql([bookingsNoOverlap, holdsNoOverlap], { casing: 'snake_case' })).toBe(
      [
        'CREATE EXTENSION IF NOT EXISTS btree_gist;',
        '--> statement-breakpoint',
        `ALTER TABLE "bookings" ADD CONSTRAINT "bookings_room_id_starts_at_ends_at_excl" EXCLUDE USING gist ("room_id" WITH =, (tstzrange("starts_at", "ends_at", '[)')) WITH &&);`,
        '--> statement-breakpoint',
        'ALTER TABLE "holds" ADD CONSTRAINT "holds_no_overlap" EXCLUDE USING gist ("room_id" WITH =);',
      ].join('\n'),
    );
  });

  it("starts with a check naming the constraint and the fix ('require')", () => {
    expect(exclusionMigrationSql([bookingsNoOverlap], { casing: 'snake_case', btreeGist: 'require' })).toBe(
      [
        'DO $drizzle_exclude$',
        'BEGIN',
        "  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist') THEN",
        `    RAISE EXCEPTION 'drizzle-exclude: exclusion constraint "bookings_room_id_starts_at_ends_at_excl" needs the btree_gist extension, which is not installed in this database.' USING HINT = 'Add CREATE EXTENSION IF NOT EXISTS btree_gist; at the top of this migration, or enable btree_gist for the database before running it (on Supabase: Database > Extensions).';`,
        '  END IF;',
        'END',
        '$drizzle_exclude$;',
        '--> statement-breakpoint',
        `ALTER TABLE "bookings" ADD CONSTRAINT "bookings_room_id_starts_at_ends_at_excl" EXCLUDE USING gist ("room_id" WITH =, (tstzrange("starts_at", "ends_at", '[)')) WITH &&);`,
      ].join('\n'),
    );
  });

  it('escapes quotes and RAISE placeholders in constraint names', () => {
    const odd = exclude(holds, { name: "holds_it's_100%", using: 'gist', with: [[holds.roomId, '=']] });

    expect(exclusionMigrationSql([odd], { btreeGist: 'require' })).toContain(
      `RAISE EXCEPTION 'drizzle-exclude: exclusion constraint "holds_it''s_100%%" needs`,
    );
  });

  it('rejects an empty list and unknown modes', () => {
    expect(() => exclusionMigrationSql([])).toThrow('needs a non-empty array of constraints');
    // @ts-expect-error only 'create' and 'require' exist
    expect(() => exclusionMigrationSql([bookingsNoOverlap], { btreeGist: 'install' })).toThrow("must be 'create' or 'require'");
  });
});
