// T2.5, against a fresh PostgreSQL without btree_gist. Tests run in order: the extension is
// only installed by the 'create' case.
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exclude, exclusionConstraintSql, exclusionMigrationSql, tstzRange } from '../../src/index.js';
import { bookings, holds } from './fixtures.js';
import { testPool } from '../support/pg.js';

const POSTGRES_IMAGE = 'postgres:18.6-alpine';
const ROOM = '11111111-1111-1111-1111-111111111111';

let container: StartedPostgreSqlContainer | undefined;
let pool: pg.Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  pool = testPool({ connectionString: container.getConnectionUri() });
  await pool.query(
    ['bookings', 'holds']
      .map(
        (table) => `CREATE TABLE ${table} (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          room_id uuid NOT NULL,
          starts_at timestamptz NOT NULL,
          ends_at timestamptz NOT NULL,
          cancelled boolean NOT NULL DEFAULT false,
          status text
        );`,
      )
      .join('\n'),
  );
});

afterAll(async () => {
  await pool.end();
  await container?.stop();
});

const bookingsNoOverlap = exclude(bookings, {
  using: 'gist',
  with: [
    [bookings.roomId, '='],
    [tstzRange(bookings.startsAt, bookings.endsAt), '&&'],
  ],
});
const holdsNoOverlap = exclude(holds, {
  using: 'gist',
  with: [
    [holds.roomId, '='],
    [tstzRange(holds.startsAt, holds.endsAt), '&&'],
  ],
});

/** Runs a migration the way drizzle-orm's migrator does: split on breakpoints, one transaction. */
async function migrate(migration: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const statement of migration.split('--> statement-breakpoint')) {
      if (statement.trim() !== '') {
        await client.query(statement);
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function hasBtreeGist(): Promise<boolean> {
  const { rowCount } = await pool.query(`SELECT 1 FROM pg_extension WHERE extname = 'btree_gist'`);
  return rowCount === 1;
}

async function hasConstraint(name: string): Promise<boolean> {
  const { rowCount } = await pool.query('SELECT 1 FROM pg_constraint WHERE conname = $1', [name]);
  return rowCount === 1;
}

describe('btree_gist in migrations', () => {
  it("without the helper, PostgreSQL's error doesn't mention the extension", async () => {
    expect(await hasBtreeGist()).toBe(false);
    await expect(migrate(exclusionConstraintSql(bookingsNoOverlap, { casing: 'snake_case' }))).rejects.toMatchObject({
      code: '42704',
      message: 'data type uuid has no default operator class for access method "gist"',
    });
  });

  it("'require' stops the migration with a message saying what to add", async () => {
    await expect(
      migrate(exclusionMigrationSql([bookingsNoOverlap], { casing: 'snake_case', btreeGist: 'require' })),
    ).rejects.toMatchObject({
      code: 'P0001',
      message:
        'drizzle-exclude: exclusion constraint "bookings_room_id_starts_at_ends_at_excl" needs the btree_gist extension, which is not installed in this database.',
      hint: expect.stringContaining('Add CREATE EXTENSION IF NOT EXISTS btree_gist; at the top of this migration') as unknown,
    });
    expect(await hasConstraint('bookings_room_id_starts_at_ends_at_excl')).toBe(false);
  });

  it("'create' installs btree_gist and the constraint rejects overlaps", async () => {
    await migrate(exclusionMigrationSql([bookingsNoOverlap], { casing: 'snake_case' }));

    expect(await hasBtreeGist()).toBe(true);
    const insert = () =>
      pool.query(`INSERT INTO bookings (room_id, starts_at, ends_at) VALUES ($1, '2026-03-01 10:00Z', '2026-03-01 11:00Z')`, [
        ROOM,
      ]);
    await insert();
    await expect(insert()).rejects.toMatchObject({ code: '23P01', constraint: 'bookings_room_id_starts_at_ends_at_excl' });
  });

  it("'require' passes once btree_gist is installed", async () => {
    await migrate(exclusionMigrationSql([holdsNoOverlap], { casing: 'snake_case', btreeGist: 'require' }));

    expect(await hasConstraint('holds_room_id_starts_at_ends_at_excl')).toBe(true);
  });
});
