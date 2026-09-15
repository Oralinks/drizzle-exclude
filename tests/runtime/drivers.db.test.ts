// T3.3: one shared suite, run once with pg and once with postgres.js. Each driver gets its own
// database with identical tables, so the parsed results can be compared field for field.
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle as drizzleNodePg } from 'drizzle-orm/node-postgres';
import { integer, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { drizzle as drizzlePostgresJs } from 'drizzle-orm/postgres-js';
import pg from 'pg';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { catchOverlap, exclude, exclusionMigrationSql, int4Range, parseExclusionViolation, tstzRange } from '../../src/index.js';

const POSTGRES_IMAGE = 'postgres:18.6-alpine';
const ROOM_A = '11111111-1111-1111-1111-111111111111';
const ROOM_C = '33333333-3333-3333-3333-333333333333';

const bookings = pgTable('bookings', {
  id: uuid().defaultRandom().primaryKey(),
  roomId: uuid().notNull(),
  startsAt: timestamp({ withTimezone: true }).notNull(),
  endsAt: timestamp({ withTimezone: true }).notNull(),
});

const deferredBookings = pgTable('deferred_bookings', {
  room: integer().notNull(),
  firstSlot: integer().notNull(),
  lastSlot: integer().notNull(),
});

const constraints = [
  exclude(bookings, {
    using: 'gist',
    with: [
      [bookings.roomId, '='],
      [tstzRange(bookings.startsAt, bookings.endsAt), '&&'],
    ],
  }),
  exclude(deferredBookings, {
    name: 'deferred_bookings_no_overlap',
    using: 'gist',
    with: [
      [deferredBookings.room, '='],
      [int4Range(deferredBookings.firstSlot, deferredBookings.lastSlot), '&&'],
    ],
    deferrable: 'deferred',
  }),
];

const TABLES_SQL = `
  CREATE TABLE bookings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id uuid NOT NULL,
    starts_at timestamptz NOT NULL,
    ends_at timestamptz NOT NULL
  );
  CREATE TABLE deferred_bookings (room integer NOT NULL, first_slot integer NOT NULL, last_slot integer NOT NULL);
  GRANT INSERT ON bookings TO writer;
`;
const INSERT_BOOKING = 'INSERT INTO bookings (room_id, starts_at, ends_at) VALUES ($1, $2, $3)';
const INSERT_DEFERRED = 'INSERT INTO deferred_bookings (room, first_slot, last_slot) VALUES ($1, $2, $3)';

/** What the shared suite needs from a driver. */
interface Connection {
  rawInsertBooking(roomId: string, startsAt: string, endsAt: string): Promise<unknown>;
  rawDeferredOverlap(): Promise<unknown>;
  drizzleInsertBooking(value: { roomId: string; startsAt: Date; endsAt: Date }): Promise<unknown>;
  end(): Promise<void>;
}

interface Driver {
  name: 'pg' | 'postgres.js';
  database: string;
  /** The field this driver puts the constraint name in, before parsing. */
  rawConstraintField: 'constraint' | 'constraint_name';
  connect(url: string): Connection;
}

const drivers: Driver[] = [
  {
    name: 'pg',
    database: 'with_pg',
    rawConstraintField: 'constraint',
    connect(url) {
      const pool = new pg.Pool({ connectionString: url, max: 12 });
      const db = drizzleNodePg({ client: pool, casing: 'snake_case' });
      return {
        rawInsertBooking: (roomId, startsAt, endsAt) => pool.query(INSERT_BOOKING, [roomId, startsAt, endsAt]),
        async rawDeferredOverlap() {
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            await client.query(INSERT_DEFERRED, [1, 1, 10]);
            await client.query(INSERT_DEFERRED, [1, 5, 15]);
            await client.query('COMMIT');
          } finally {
            client.release();
          }
        },
        drizzleInsertBooking: (value) => db.insert(bookings).values(value),
        end: () => pool.end(),
      };
    },
  },
  {
    name: 'postgres.js',
    database: 'with_postgres_js',
    rawConstraintField: 'constraint_name',
    connect(url) {
      const sql = postgres(url, { max: 12, onnotice: () => undefined });
      const db = drizzlePostgresJs({ client: sql, casing: 'snake_case' });
      return {
        rawInsertBooking: async (roomId, startsAt, endsAt) => sql.unsafe(INSERT_BOOKING, [roomId, startsAt, endsAt]),
        rawDeferredOverlap: () =>
          sql.begin(async (tx) => {
            await tx.unsafe(INSERT_DEFERRED, [1, 1, 10]);
            await tx.unsafe(INSERT_DEFERRED, [1, 5, 15]);
          }),
        drizzleInsertBooking: (value) => db.insert(bookings).values(value),
        end: () => sql.end(),
      };
    },
  },
];

let container: StartedPostgreSqlContainer | undefined;

function databaseUrl(database: string, user?: string): string {
  const url = new URL(container?.getConnectionUri() ?? '');
  url.pathname = `/${database}`;
  if (user !== undefined) {
    url.username = user;
    url.password = user;
  }
  return url.toString();
}

beforeAll(async () => {
  container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  const admin = new pg.Pool({ connectionString: container.getConnectionUri() });
  try {
    await admin.query(`CREATE ROLE writer LOGIN PASSWORD 'writer'`);
    for (const driver of drivers) {
      await admin.query(`CREATE DATABASE ${driver.database}`);
      const setup = new pg.Pool({ connectionString: databaseUrl(driver.database) });
      try {
        await setup.query(TABLES_SQL);
        await setup.query(exclusionMigrationSql(constraints, { casing: 'snake_case' }));
        await setup.query(`INSERT INTO bookings (room_id, starts_at, ends_at) VALUES ($1, '2026-03-01 10:00Z', '2026-03-01 11:00Z')`, [
          ROOM_A,
        ]);
      } finally {
        await setup.end();
      }
    }
  } finally {
    await admin.end();
  }
});

afterAll(async () => {
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

/** Results per driver, compared at the end. */
const recorded: Record<Driver['name'], Record<string, unknown>> = { pg: {}, 'postgres.js': {} };

describe.each(drivers)('with $name', (driver) => {
  let connection: Connection;
  let writer: Connection;

  beforeAll(() => {
    connection = driver.connect(databaseUrl(driver.database));
    writer = driver.connect(databaseUrl(driver.database, 'writer'));
  });

  afterAll(async () => {
    await connection.end();
    await writer.end();
  });

  it('parses a raw driver error', async () => {
    const error = await errorFrom(connection.rawInsertBooking(ROOM_A, '2026-03-01T10:30:00Z', '2026-03-01T11:30:00Z'));
    const violation = parseExclusionViolation(error);

    expect(error).toMatchObject({ code: '23P01', [driver.rawConstraintField]: 'bookings_room_id_starts_at_ends_at_excl' });
    expect(violation).toEqual({
      kind: 'conflict',
      constraint: 'bookings_room_id_starts_at_ends_at_excl',
      table: 'bookings',
      schema: 'public',
      conflictingKey: {
        columns: ['room_id', "tstzrange(starts_at, ends_at, '[)'::text)"],
        attempted: `${ROOM_A}, ["2026-03-01 10:30:00+00","2026-03-01 11:30:00+00")`,
        existing: `${ROOM_A}, ["2026-03-01 10:00:00+00","2026-03-01 11:00:00+00")`,
      },
      detail: expect.any(String) as unknown,
    });
    recorded[driver.name].rawError = violation;
  });

  it('parses a deferred violation raised at COMMIT', async () => {
    const violation = parseExclusionViolation(await errorFrom(connection.rawDeferredOverlap()));

    expect(violation).toMatchObject({
      kind: 'conflict',
      constraint: 'deferred_bookings_no_overlap',
      table: 'deferred_bookings',
      conflictingKey: {
        columns: ['room', "int4range(first_slot, last_slot, '[)'::text)"],
        attempted: '1, [5,15)',
        existing: '1, [1,10)',
      },
    });
    recorded[driver.name].deferred = violation;
  });

  it('reports the constraint when the key is withheld from a role without SELECT', async () => {
    const violation = parseExclusionViolation(
      await errorFrom(writer.rawInsertBooking(ROOM_A, '2026-03-01T10:15:00Z', '2026-03-01T10:45:00Z')),
    );

    expect(violation).toEqual({
      kind: 'conflict',
      constraint: 'bookings_room_id_starts_at_ends_at_excl',
      table: 'bookings',
      schema: 'public',
      conflictingKey: undefined,
      detail: 'Key conflicts with existing key.',
    });
    recorded[driver.name].keyWithheld = violation;
  });

  it('returns an overlap from catchOverlap() through Drizzle', async () => {
    const result = await catchOverlap(
      connection.drizzleInsertBooking({
        roomId: ROOM_A,
        startsAt: new Date('2026-03-01T10:15:00Z'),
        endsAt: new Date('2026-03-01T10:45:00Z'),
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      reason: 'overlap',
      constraint: 'bookings_room_id_starts_at_ends_at_excl',
      conflictingKey: { attempted: `${ROOM_A}, ["2026-03-01 10:15:00+00","2026-03-01 10:45:00+00")` },
    });
    recorded[driver.name].catchOverlap = result;
  });

  it('resolves 10 concurrent bookings with exactly one success', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        catchOverlap(() =>
          connection.drizzleInsertBooking({
            roomId: ROOM_C,
            startsAt: new Date('2026-03-01T09:00:00Z'),
            endsAt: new Date('2026-03-01T10:00:00Z'),
          }),
        ),
      ),
    );

    expect(results.map((result) => (result.ok ? 'ok' : result.reason)).filter((outcome) => outcome === 'ok')).toHaveLength(1);
  });
});

describe('across drivers', () => {
  it('pg and postgres.js give identical results', () => {
    expect(Object.keys(recorded.pg)).toEqual(['rawError', 'deferred', 'keyWithheld', 'catchOverlap']);
    expect(recorded['postgres.js']).toEqual(recorded.pg);
  });
});
