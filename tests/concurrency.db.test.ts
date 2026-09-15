// T1.4: the package's central argument, run against real PostgreSQL.
// T2.6: the guarded table's constraint is defined with exclude() and applied with exclusionMigrationSql().
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { bigint, boolean, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { exclude, exclusionMigrationSql, tstzRange } from '../src/index.js';
import { testPool } from './support/pg.js';

const POSTGRES_IMAGE = 'postgres:18.6-alpine';
const ATTEMPTS = 10;
const ROOM_ID = '11111111-1111-1111-1111-111111111111';
const STARTS_AT = '2026-03-01T10:00:00Z';
const ENDS_AT = '2026-03-01T11:00:00Z';

type Table = 'bookings_unguarded' | 'bookings_guarded';
type Outcome = { ok: true } | { ok: false; code: string | undefined };

let container: StartedPostgreSqlContainer | undefined;
let pool: pg.Pool;

const bookingsGuarded = pgTable('bookings_guarded', {
  id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  roomId: uuid().notNull(),
  startsAt: timestamp({ withTimezone: true }).notNull(),
  endsAt: timestamp({ withTimezone: true }).notNull(),
  cancelled: boolean().notNull().default(false),
});

const bookingsNoOverlap = exclude(bookingsGuarded, {
  name: 'bookings_guarded_no_overlap',
  using: 'gist',
  with: [
    [bookingsGuarded.roomId, '='],
    [tstzRange(bookingsGuarded.startsAt, bookingsGuarded.endsAt), '&&'],
  ],
  where: sql`not ${bookingsGuarded.cancelled}`,
});

beforeAll(async () => {
  container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  pool = testPool({ connectionString: container.getConnectionUri(), max: ATTEMPTS + 2 });
  // The tables are what drizzle-kit would create. The guarded table's constraint, and the
  // btree_gist it needs, come from the package's migration SQL rather than hand-written DDL.
  await pool.query(`
    CREATE TABLE bookings_unguarded (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      room_id uuid NOT NULL,
      starts_at timestamptz NOT NULL,
      ends_at timestamptz NOT NULL,
      cancelled boolean NOT NULL DEFAULT false
    );

    CREATE TABLE bookings_guarded (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      room_id uuid NOT NULL,
      starts_at timestamptz NOT NULL,
      ends_at timestamptz NOT NULL,
      cancelled boolean NOT NULL DEFAULT false
    );
  `);
  await pool.query(exclusionMigrationSql([bookingsNoOverlap], { casing: 'snake_case' }));
});

afterAll(async () => {
  await pool.end();
  await container?.stop();
});

beforeEach(async () => {
  await pool.query('TRUNCATE bookings_unguarded, bookings_guarded');
});

/** Returns a gate that opens once `size` callers are waiting at it. */
function createBarrier(size: number): () => Promise<void> {
  let arrived = 0;
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return () => {
    arrived += 1;
    if (arrived === size) open();
    return opened;
  };
}

function sqlState(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

/** The usual application-level guard: look for an overlap, insert if there is none. */
async function checkThenInsert(table: Table, waitForOthers: () => Promise<void>): Promise<Outcome> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ taken: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM ${table}
         WHERE room_id = $1
           AND NOT cancelled
           AND tstzrange(starts_at, ends_at, '[)') && tstzrange($2::timestamptz, $3::timestamptz, '[)')
       ) AS taken`,
      [ROOM_ID, STARTS_AT, ENDS_AT],
    );
    // Every attempt finishes its check before any attempt inserts. This forces the
    // worst-case interleaving deterministically instead of leaving it to timing.
    await waitForOthers();
    if (rows[0]?.taken) {
      await client.query('ROLLBACK');
      return { ok: false, code: 'rejected-by-check' };
    }
    await client.query(`INSERT INTO ${table} (room_id, starts_at, ends_at) VALUES ($1, $2, $3)`, [
      ROOM_ID,
      STARTS_AT,
      ENDS_AT,
    ]);
    await client.query('COMMIT');
    return { ok: true };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    return { ok: false, code: sqlState(error) };
  } finally {
    client.release();
  }
}

async function race(table: Table) {
  const barrier = createBarrier(ATTEMPTS);
  const outcomes = await Promise.all(Array.from({ length: ATTEMPTS }, () => checkThenInsert(table, barrier)));
  const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE room_id = $1`, [
    ROOM_ID,
  ]);
  return {
    winners: outcomes.filter((outcome) => outcome.ok).length,
    failureCodes: outcomes.flatMap((outcome) => (outcome.ok ? [] : [outcome.code])),
    rowsWritten: rows[0]?.n,
  };
}

describe(`${String(ATTEMPTS)} concurrent check-then-insert attempts for the same room and time`, () => {
  it('double-books when only application code checks for overlaps (negative control)', async () => {
    const result = await race('bookings_unguarded');
    console.info('unguarded:', result);

    expect(result.winners).toBeGreaterThan(1);
    expect(result.rowsWritten).toBe(result.winners);
  });

  it('books exactly once when an exclusion constraint guards the table', async () => {
    const result = await race('bookings_guarded');
    console.info('guarded:', result);

    expect(result.winners).toBe(1);
    expect(result.rowsWritten).toBe(1);
    // Losers get exclusion_violation or, when conflicting inserts land at the same
    // instant, deadlock_detected. Both are the database refusing the booking (D16).
    expect(result.failureCodes).toHaveLength(ATTEMPTS - 1);
    expect(result.failureCodes.filter((code) => code !== '23P01' && code !== '40P01')).toEqual([]);
  });
});
