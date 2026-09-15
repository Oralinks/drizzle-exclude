// An outside project testing its own table with drizzle-exclude/testing. Everything is imported by
// package name, from the packed tarball, exactly as an npm user would.
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { catchOverlap, exclusionMigrationSql } from 'drizzle-exclude';
import { expectNoOverlap, raceAttempts } from 'drizzle-exclude/testing';
import { and, eq, gt, lt, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deskReservations, oneMemberPerDesk } from '../src/schema.js';

let container: StartedPostgreSqlContainer | undefined;
let pool: pg.Pool;
let db: NodePgDatabase;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18.6-alpine').start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  // Stopping the container can reach clients that are still closing; don't let that crash the run.
  pool.on('connect', (client) => client.on('error', () => undefined));
  db = drizzle({ client: pool, casing: 'snake_case' });
  // The table as drizzle-kit would create it.
  await pool.query(`
    CREATE TABLE desk_reservations (
      id serial PRIMARY KEY,
      desk_id integer NOT NULL,
      member text NOT NULL,
      starts_at timestamptz NOT NULL,
      ends_at timestamptz NOT NULL
    )
  `);
});

afterAll(async () => {
  await pool.end();
  await container?.stop();
});

const workingDay = {
  deskId: 7,
  startsAt: new Date('2026-04-01T09:00:00Z'),
  endsAt: new Date('2026-04-01T17:00:00Z'),
};

describe('desk reservations', () => {
  it('double-books when the app checks before inserting, and expectNoOverlap() catches it', async () => {
    const { values } = await raceAttempts(
      async ({ index, checkpoint }) => {
        const clash = await db
          .select({ id: deskReservations.id })
          .from(deskReservations)
          .where(
            and(
              eq(deskReservations.deskId, workingDay.deskId),
              lt(deskReservations.startsAt, workingDay.endsAt),
              gt(deskReservations.endsAt, workingDay.startsAt),
            ),
          );
        await checkpoint();
        if (clash.length > 0) return 'taken';
        await db.insert(deskReservations).values({ ...workingDay, member: `member ${String(index)}` });
        return 'reserved';
      },
      { attempts: 8 },
    );

    expect(values.filter((value) => value === 'reserved').length).toBeGreaterThan(1);
    await expect(expectNoOverlap(db, oneMemberPerDesk, { casing: 'snake_case' })).rejects.toThrow('clashing pair');
  });

  it('gives exactly one of eight simultaneous reservations the desk once the constraint is applied', async () => {
    await db.execute(sql`truncate desk_reservations`);
    await db.execute(sql.raw(exclusionMigrationSql([oneMemberPerDesk], { casing: 'snake_case' })));

    const { values, errors } = await raceAttempts(
      ({ index }) => catchOverlap(db.insert(deskReservations).values({ ...workingDay, member: `member ${String(index)}` })),
      { attempts: 8 },
    );

    expect(errors).toEqual([]);
    expect(values.filter((result) => result.ok)).toHaveLength(1);
    await expectNoOverlap(db, oneMemberPerDesk, { casing: 'snake_case' });
  });
});
