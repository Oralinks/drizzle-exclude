// T3.4: moving three bookings in a cycle (A to B's slot, B to C's, C to A's) is impossible while the
// exclusion constraint is checked per statement, and works with the constraint deferred to COMMIT.
// Runs with both drivers, each against its own database.
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle as drizzleNodePg } from 'drizzle-orm/node-postgres';
import { integer, type PgDatabase, type PgQueryResultHKT, pgTable, text } from 'drizzle-orm/pg-core';
import { drizzle as drizzlePostgresJs } from 'drizzle-orm/postgres-js';
import pg from 'pg';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { catchOverlap, exclude, exclusionMigrationSql, int4Range, withDeferredConstraints } from '../../src/index.js';

const POSTGRES_IMAGE = 'postgres:18.6-alpine';

const slots = pgTable('slots', {
  id: text().primaryKey(),
  room: integer().notNull(),
  firstSlot: integer().notNull(),
  lastSlot: integer().notNull(),
});

const slotsNoOverlap = exclude(slots, {
  name: 'slots_no_overlap',
  using: 'gist',
  with: [
    [slots.room, '='],
    [int4Range(slots.firstSlot, slots.lastSlot), '&&'],
  ],
  deferrable: 'immediate',
});

interface Move {
  id: string;
  first: number;
  last: number;
}

/** A → B's slot, B → C's, C → A's. Every intermediate state overlaps. */
const CYCLE: Move[] = [
  { id: 'A', first: 2, last: 3 },
  { id: 'B', first: 3, last: 4 },
  { id: 'C', first: 1, last: 2 },
];

function operations<TQueryResult extends PgQueryResultHKT>(db: PgDatabase<TQueryResult>) {
  return {
    moveInPlainTransaction: (moves: Move[]) =>
      catchOverlap(() =>
        db.transaction(async (tx) => {
          for (const move of moves) {
            await tx.update(slots).set({ firstSlot: move.first, lastSlot: move.last }).where(eq(slots.id, move.id));
          }
        }),
      ),
    moveDeferred: (moves: Move[], afterMoves: () => void = () => undefined) =>
      withDeferredConstraints(
        db,
        [slotsNoOverlap],
        async (tx) => {
          for (const move of moves) {
            await tx.update(slots).set({ firstSlot: move.first, lastSlot: move.last }).where(eq(slots.id, move.id));
          }
          afterMoves();
          return 'moved';
        },
        { casing: 'snake_case' },
      ),
    rows: async () =>
      Object.fromEntries((await db.select().from(slots).orderBy(slots.id)).map((row) => [row.id, `[${String(row.firstSlot)},${String(row.lastSlot)})`])),
  };
}

type Connection = ReturnType<typeof operations> & { end(): Promise<void> };

const drivers: { name: string; database: string; connect(url: string): Connection }[] = [
  {
    name: 'pg',
    database: 'deferred_pg',
    connect(url) {
      const pool = new pg.Pool({ connectionString: url });
      return { ...operations(drizzleNodePg({ client: pool, casing: 'snake_case' })), end: () => pool.end() };
    },
  },
  {
    name: 'postgres.js',
    database: 'deferred_postgres_js',
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
        await setup.query(
          'CREATE TABLE slots (id text PRIMARY KEY, room integer NOT NULL, first_slot integer NOT NULL, last_slot integer NOT NULL)',
        );
        await setup.query(exclusionMigrationSql([slotsNoOverlap], { casing: 'snake_case' }));
        await setup.query(`INSERT INTO slots VALUES ('A', 1, 1, 2), ('B', 1, 2, 3), ('C', 1, 3, 4)`);
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

describe.each(drivers)('with $name', (driver) => {
  let connection: Connection;

  beforeAll(() => {
    connection = driver.connect(databaseUrl(driver.database));
  });

  afterAll(async () => {
    await connection.end();
  });

  it('cannot move three bookings in a cycle in a plain transaction', async () => {
    const result = await connection.moveInPlainTransaction(CYCLE);

    expect(result).toMatchObject({ ok: false, reason: 'overlap', constraint: 'slots_no_overlap' });
    expect(await connection.rows()).toEqual({ A: '[1,2)', B: '[2,3)', C: '[3,4)' });
  });

  it('moves them with the constraint deferred to COMMIT', async () => {
    const result = await connection.moveDeferred(CYCLE);

    expect(result).toEqual({ ok: true, value: 'moved' });
    expect(await connection.rows()).toEqual({ A: '[2,3)', B: '[3,4)', C: '[1,2)' });
  });

  it('returns an overlap when the final arrangement still clashes, and changes nothing', async () => {
    const result = await connection.moveDeferred([{ id: 'A', first: 3, last: 4 }]);

    expect(result).toMatchObject({ ok: false, reason: 'overlap', constraint: 'slots_no_overlap' });
    expect(await connection.rows()).toEqual({ A: '[2,3)', B: '[3,4)', C: '[1,2)' });
  });

  it('rethrows an error from the work and rolls the moves back', async () => {
    const failure = new Error('payment declined');

    await expect(
      connection.moveDeferred([{ id: 'A', first: 7, last: 8 }], () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(await connection.rows()).toEqual({ A: '[2,3)', B: '[3,4)', C: '[1,2)' });
  });
});
