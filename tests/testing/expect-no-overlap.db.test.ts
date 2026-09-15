// T4.1: expectNoOverlap() against real PostgreSQL with both drivers. The table has no constraint,
// so rows can clash; at the end, PostgreSQL itself must accept the constraint on the cleaned table.
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { drizzle as drizzleNodePg } from 'drizzle-orm/node-postgres';
import { boolean, integer, type PgDatabase, type PgQueryResultHKT, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';
import { drizzle as drizzlePostgresJs } from 'drizzle-orm/postgres-js';
import pg from 'pg';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exclude, type ExclusionConstraint, exclusionMigrationSql, tstzRange } from '../../src/index.js';
import { expectNoOverlap, type ExpectNoOverlapOptions } from '../../src/testing/index.js';

const POSTGRES_IMAGE = 'postgres:18.6-alpine';

const bookings = pgTable('bookings', {
  id: serial().primaryKey(),
  roomId: integer(),
  startsAt: timestamp({ withTimezone: true }).notNull(),
  endsAt: timestamp({ withTimezone: true }).notNull(),
  cancelled: boolean().notNull().default(false),
  name: text(),
});

const roomAndTime = exclude(bookings, {
  using: 'gist',
  with: [
    [bookings.roomId, '='],
    [tstzRange(bookings.startsAt, bookings.endsAt), '&&'],
  ],
  where: sql`not ${bookings.cancelled}`,
});
const roomAndTimeEvenCancelled = exclude(bookings, {
  name: 'bookings_even_cancelled_excl',
  using: 'gist',
  with: [
    [bookings.roomId, '='],
    [tstzRange(bookings.startsAt, bookings.endsAt), '&&'],
  ],
});
const caseInsensitiveName = exclude(bookings, { using: 'gist', with: [[sql`lower(${bookings.name})`, '=']] });

const SETUP_SQL = `
  CREATE TABLE bookings (
    id serial PRIMARY KEY, room_id integer, starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
    cancelled boolean NOT NULL DEFAULT false, name text
  );
  INSERT INTO bookings (room_id, starts_at, ends_at, cancelled, name) VALUES
    (1,    '2026-03-01 10:00Z', '2026-03-01 11:00Z', false, 'Ada'),
    (1,    '2026-03-01 10:30Z', '2026-03-01 11:30Z', false, 'Bob'),
    (1,    '2026-03-01 11:00Z', '2026-03-01 12:00Z', false, 'ada'),
    (1,    '2026-03-01 10:15Z', '2026-03-01 10:45Z', true,  'Cy'),
    (2,    '2026-03-01 10:00Z', '2026-03-01 11:00Z', false, 'Dee'),
    (NULL, '2026-03-01 10:00Z', '2026-03-01 11:00Z', false, 'Eve');
`;

function operations<TQueryResult extends PgQueryResultHKT>(db: PgDatabase<TQueryResult>) {
  return {
    expectNoOverlap: (constraint: ExclusionConstraint, options: ExpectNoOverlapOptions = {}) =>
      expectNoOverlap(db, constraint, { casing: 'snake_case', ...options }),
    run: (statement: string) => db.execute(sql.raw(statement)),
  };
}

type Connection = ReturnType<typeof operations> & { end(): Promise<void> };

const drivers: { name: string; database: string; connect(url: string): Connection }[] = [
  {
    name: 'pg',
    database: 'overlaps_pg',
    connect(url) {
      const pool = new pg.Pool({ connectionString: url });
      return { ...operations(drizzleNodePg({ client: pool, casing: 'snake_case' })), end: () => pool.end() };
    },
  },
  {
    name: 'postgres.js',
    database: 'overlaps_postgres_js',
    connect(url) {
      const client = postgres(url, { onnotice: () => undefined });
      return { ...operations(drizzlePostgresJs({ client, casing: 'snake_case' })), end: () => client.end() };
    },
  },
];

let container: StartedPostgreSqlContainer | undefined;

function databaseUrl(database: string): string {
  const url = new URL(container?.getConnectionUri() ?? '');
  url.pathname = `/${database}`;
  return url.toString();
}

beforeAll(async () => {
  container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  const admin = new pg.Pool({ connectionString: container.getConnectionUri() });
  try {
    for (const driver of drivers) {
      await admin.query(`CREATE DATABASE ${driver.database}`);
      const setup = new pg.Pool({ connectionString: databaseUrl(driver.database) });
      try {
        await setup.query(SETUP_SQL);
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

async function failureOf(assertion: Promise<void>): Promise<string> {
  try {
    await assertion;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected expectNoOverlap() to reject');
}

/** The ids in each listed pair, in order. */
const listedIds = (message: string) => [...message.matchAll(/\{"id": ?(\d+)/g)].map((match) => Number(match[1]));

describe.each(drivers)('with $name', (driver) => {
  let connection: Connection;

  beforeAll(() => {
    connection = driver.connect(databaseUrl(driver.database));
  });

  afterAll(async () => {
    await connection.end();
  });

  it('lists overlapping bookings, ignoring cancelled, back-to-back, other-room and NULL-room rows', async () => {
    const message = await failureOf(connection.expectNoOverlap(roomAndTime));

    expect(message).toContain('exclusion constraint "bookings_room_id_starts_at_ends_at_excl", but found 2 clashing pairs:');
    expect(listedIds(message)).toEqual([1, 2, 2, 3]);
  });

  it('counts cancelled rows when the constraint has no WHERE', async () => {
    expect(listedIds(await failureOf(connection.expectNoOverlap(roomAndTimeEvenCancelled)))).toEqual([1, 2, 1, 4, 2, 3, 2, 4]);
  });

  it('checks expression elements', async () => {
    expect(listedIds(await failureOf(connection.expectNoOverlap(caseInsensitiveName)))).toEqual([1, 3]);
  });

  it('lists at most `limit` pairs', async () => {
    const message = await failureOf(connection.expectNoOverlap(roomAndTime, { limit: 1 }));

    expect(message).toContain('but found more than 1 clashing pairs. The first 1:');
    expect(listedIds(message)).toEqual([1, 2]);
  });

  it('passes once the clash is removed, and PostgreSQL then accepts the constraint', async () => {
    await connection.run('DELETE FROM bookings WHERE id = 2');

    await expect(connection.expectNoOverlap(roomAndTime)).resolves.toBeUndefined();
    await connection.run(exclusionMigrationSql([roomAndTime], { casing: 'snake_case' }));
  });
});
