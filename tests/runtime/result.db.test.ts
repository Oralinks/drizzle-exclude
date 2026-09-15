// T3.2: catchOverlap() around real Drizzle writes against PostgreSQL, with the constraint applied
// from the package's own migration SQL.
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DrizzleQueryError } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { catchOverlap, exclude, exclusionMigrationSql, tstzRange } from '../../src/index.js';

const POSTGRES_IMAGE = 'postgres:18.6-alpine';
const ROOM_A = '11111111-1111-1111-1111-111111111111';
const ROOM_B = '22222222-2222-2222-2222-222222222222';
const ROOM_C = '33333333-3333-3333-3333-333333333333';

const bookings = pgTable('bookings', {
  id: uuid().defaultRandom().primaryKey(),
  roomId: uuid().notNull(),
  startsAt: timestamp({ withTimezone: true }).notNull(),
  endsAt: timestamp({ withTimezone: true }).notNull(),
});

const bookingsNoOverlap = exclude(bookings, {
  using: 'gist',
  with: [
    [bookings.roomId, '='],
    [tstzRange(bookings.startsAt, bookings.endsAt), '&&'],
  ],
});

let container: StartedPostgreSqlContainer | undefined;
let pool: pg.Pool;
let db: NodePgDatabase;

beforeAll(async () => {
  container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 12 });
  db = drizzle({ client: pool, casing: 'snake_case' });
  await pool.query(`
    CREATE TABLE bookings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      room_id uuid NOT NULL,
      starts_at timestamptz NOT NULL,
      ends_at timestamptz NOT NULL
    );
  `);
  await pool.query(exclusionMigrationSql([bookingsNoOverlap], { casing: 'snake_case' }));
});

afterAll(async () => {
  await pool.end();
  await container?.stop();
});

const slot = (roomId: string, from: string, to: string) => ({
  roomId,
  startsAt: new Date(`2026-03-01T${from}:00Z`),
  endsAt: new Date(`2026-03-01T${to}:00Z`),
});

describe('catchOverlap() with Drizzle and PostgreSQL', () => {
  it('returns the inserted rows when the slot is free', async () => {
    const result = await catchOverlap(db.insert(bookings).values(slot(ROOM_A, '10:00', '11:00')).returning());

    expect(result.ok).toBe(true);
    expect(result.ok && result.value[0]?.roomId).toBe(ROOM_A);
  });

  it('returns an overlap naming the constraint when the slot is taken', async () => {
    const result = await catchOverlap(db.insert(bookings).values(slot(ROOM_A, '10:30', '11:30')).returning());

    expect(result).toMatchObject({
      ok: false,
      reason: 'overlap',
      constraint: 'bookings_room_id_starts_at_ends_at_excl',
      conflictingKey: {
        attempted: `${ROOM_A}, ["2026-03-01 10:30:00+00","2026-03-01 11:30:00+00")`,
        existing: `${ROOM_A}, ["2026-03-01 10:00:00+00","2026-03-01 11:00:00+00")`,
      },
    });
  });

  it('allows back-to-back bookings and other rooms', async () => {
    await expect(catchOverlap(db.insert(bookings).values(slot(ROOM_A, '11:00', '12:00')))).resolves.toMatchObject({ ok: true });
    await expect(catchOverlap(db.insert(bookings).values(slot(ROOM_B, '10:30', '11:30')))).resolves.toMatchObject({ ok: true });
  });

  it('rethrows errors that are not about overlaps', async () => {
    const [existing] = await db.select().from(bookings).limit(1);
    const duplicateId = { ...slot(ROOM_B, '20:00', '21:00'), id: existing?.id ?? '' };

    const error: unknown = await catchOverlap(db.insert(bookings).values(duplicateId)).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(DrizzleQueryError);
    expect((error as DrizzleQueryError).cause).toMatchObject({ code: '23505' });
  });

  it('resolves every concurrent attempt: exactly one booking, the rest overlap or contention', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => catchOverlap(() => db.insert(bookings).values(slot(ROOM_C, '09:00', '10:00')))),
    );

    // Promise.all resolved, so no attempt threw: each one returned ok, overlap or contention.
    const outcomes = results.map((result) => (result.ok ? 'ok' : result.reason));
    expect(outcomes).toHaveLength(10);
    expect(outcomes.filter((outcome) => outcome === 'ok')).toHaveLength(1);
    const [{ count }] = (await pool.query<{ count: number }>('SELECT count(*)::int AS count FROM bookings WHERE room_id = $1', [ROOM_C]))
      .rows as [{ count: number }];
    expect(count).toBe(1);
  });
});
