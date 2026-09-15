// T3.1: produce each exclusion-violation shape live in PostgreSQL and parse it.
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DrizzleQueryError } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { boolean, pgSchema, serial, timestamp, uuid } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseExclusionViolation } from '../../src/index.js';
import { testPool } from '../support/pg.js';

const POSTGRES_IMAGE = 'postgres:18.6-alpine';
const ROOM = '11111111-1111-1111-1111-111111111111';

const appBookings = pgSchema('app').table('bookings', {
  id: serial().primaryKey(),
  roomId: uuid('room_id').notNull(),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  cancelled: boolean().notNull().default(false),
});

let container: StartedPostgreSqlContainer | undefined;
let pool: pg.Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  pool = testPool({ connectionString: container.getConnectionUri() });
  await pool.query(`
    CREATE EXTENSION btree_gist;
    CREATE SCHEMA app;
    CREATE TABLE app.bookings (
      id serial PRIMARY KEY, room_id uuid NOT NULL, starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
      cancelled boolean NOT NULL DEFAULT false,
      CONSTRAINT bookings_room_id_starts_at_ends_at_excl
        EXCLUDE USING gist (room_id WITH =, (tstzrange(starts_at, ends_at, '[)')) WITH &&) WHERE (not cancelled)
    );
    CREATE TABLE notes (label text, during tsrange,
      CONSTRAINT notes_label_during_excl EXCLUDE USING gist (label WITH =, during WITH &&));
    CREATE TABLE lowered (name text, CONSTRAINT lowered_name_excl EXCLUDE USING gist ((lower(name)) WITH =));
    CREATE TABLE deferred_bookings (room int, during int4range,
      CONSTRAINT deferred_bookings_room_during_excl EXCLUDE USING gist (room WITH =, during WITH &&) DEFERRABLE INITIALLY DEFERRED);
    CREATE ROLE writer LOGIN PASSWORD 'writer';
    GRANT USAGE ON SCHEMA app TO writer;
    GRANT INSERT ON app.bookings TO writer;
    GRANT USAGE ON SEQUENCE app.bookings_id_seq TO writer;
  `);
  await pool.query(
    `INSERT INTO app.bookings (room_id, starts_at, ends_at) VALUES ($1, '2026-03-01 10:00Z', '2026-03-01 11:00Z')`,
    [ROOM],
  );
});

afterAll(async () => {
  await pool.end();
  await container?.stop();
});

async function errorFrom(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error('expected the operation to fail');
}

const overlappingBooking = (client: pg.Pool | pg.PoolClient) =>
  client.query(`INSERT INTO app.bookings (room_id, starts_at, ends_at) VALUES ($1, '2026-03-01 10:30Z', '2026-03-01 11:30Z')`, [
    ROOM,
  ]);

describe('parseExclusionViolation() on live PostgreSQL errors', () => {
  it('a conflicting insert', async () => {
    expect(parseExclusionViolation(await errorFrom(overlappingBooking(pool)))).toEqual({
      kind: 'conflict',
      constraint: 'bookings_room_id_starts_at_ends_at_excl',
      table: 'bookings',
      schema: 'app',
      conflictingKey: {
        columns: ['room_id', "tstzrange(starts_at, ends_at, '[)'::text)"],
        attempted: `${ROOM}, ["2026-03-01 10:30:00+00","2026-03-01 11:30:00+00")`,
        existing: `${ROOM}, ["2026-03-01 10:00:00+00","2026-03-01 11:00:00+00")`,
      },
      detail: expect.stringMatching(/^Key \(room_id, /) as unknown,
    });
  });

  it('a conflicting insert thrown through Drizzle, wrapped in DrizzleQueryError', async () => {
    const db = drizzle({ client: pool });
    const error = await errorFrom(
      db.insert(appBookings).values({
        roomId: ROOM,
        startsAt: new Date('2026-03-01T10:15:00Z'),
        endsAt: new Date('2026-03-01T10:45:00Z'),
      }),
    );

    expect(error).toBeInstanceOf(DrizzleQueryError);
    expect(parseExclusionViolation(error)).toMatchObject({
      kind: 'conflict',
      constraint: 'bookings_room_id_starts_at_ends_at_excl',
      conflictingKey: { attempted: `${ROOM}, ["2026-03-01 10:15:00+00","2026-03-01 10:45:00+00")` },
    });
  });

  it('values follow the session time zone', async () => {
    const client = await pool.connect();
    try {
      await client.query(`SET TimeZone = 'Asia/Kolkata'`);
      const violation = parseExclusionViolation(await errorFrom(overlappingBooking(client)));

      expect(violation?.conflictingKey?.attempted).toBe(`${ROOM}, ["2026-03-01 16:00:00+05:30","2026-03-01 17:00:00+05:30")`);
    } finally {
      await client.query('RESET TimeZone');
      client.release();
    }
  });

  it('a text value with a comma, a parenthesis and quotes', async () => {
    const label = `a, b) "c"='d'`;
    await pool.query(`INSERT INTO notes VALUES ($1, '[2026-01-01 10:00, 2026-01-01 11:00)')`, [label]);
    const error = await errorFrom(pool.query(`INSERT INTO notes VALUES ($1, '[2026-01-01 10:30, 2026-01-01 11:30)')`, [label]));

    expect(parseExclusionViolation(error)?.conflictingKey).toEqual({
      columns: ['label', 'during'],
      attempted: `${label}, ["2026-01-01 10:30:00","2026-01-01 11:30:00")`,
      existing: `${label}, ["2026-01-01 10:00:00","2026-01-01 11:00:00")`,
    });
  });

  it('an expression element', async () => {
    await pool.query(`INSERT INTO lowered VALUES ('Alice')`);
    const error = await errorFrom(pool.query(`INSERT INTO lowered VALUES ('ALICE')`));

    expect(parseExclusionViolation(error)?.conflictingKey).toEqual({ columns: ['lower(name)'], attempted: 'alice', existing: 'alice' });
  });

  it('a role without SELECT: the key is withheld, the constraint is still reported', async () => {
    const uri = new URL(container?.getConnectionUri() ?? '');
    uri.username = 'writer';
    uri.password = 'writer';
    const writer = testPool({ connectionString: uri.toString() });
    try {
      expect(parseExclusionViolation(await errorFrom(overlappingBooking(writer)))).toEqual({
        kind: 'conflict',
        constraint: 'bookings_room_id_starts_at_ends_at_excl',
        table: 'bookings',
        schema: 'app',
        conflictingKey: undefined,
        detail: 'Key conflicts with existing key.',
      });
    } finally {
      await writer.end();
    }
  });

  it('a deferred constraint at COMMIT', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO deferred_bookings VALUES (1, '[1,10)')`);
      await client.query(`INSERT INTO deferred_bookings VALUES (1, '[5,15)')`);

      expect(parseExclusionViolation(await errorFrom(client.query('COMMIT')))).toMatchObject({
        kind: 'conflict',
        constraint: 'deferred_bookings_room_during_excl',
        conflictingKey: { columns: ['room', 'during'], attempted: '1, [5,15)', existing: '1, [1,10)' },
      });
    } finally {
      client.release();
    }
  });

  it('adding a constraint over existing conflicts', async () => {
    await pool.query(`CREATE TABLE late (room int, during int4range); INSERT INTO late VALUES (1, '[1,10)'), (1, '[5,15)');`);
    const error = await errorFrom(
      pool.query(`ALTER TABLE late ADD CONSTRAINT late_room_during_excl EXCLUDE USING gist (room WITH =, during WITH &&)`),
    );

    expect(parseExclusionViolation(error)).toMatchObject({
      kind: 'existing-rows',
      constraint: 'late_room_during_excl',
      conflictingKey: { columns: ['room', 'during'], attempted: '1, [1,10)', existing: '1, [5,15)' },
    });
  });
});
