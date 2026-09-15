// T2.4: every statement exclusionConstraintSql() renders must create a working constraint
// in real PostgreSQL. Each case runs the statement, checks pg_constraint, and proves an
// overlapping insert is rejected.
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exclude, exclusionConstraintSql, tstzRange } from '../../src/index.js';
import { archivedBookings, bookings, createTablesSql, holds, reservation, roomReservation } from './fixtures.js';

const POSTGRES_IMAGE = 'postgres:18.6-alpine';
const ROOM = '11111111-1111-1111-1111-111111111111';

let container: StartedPostgreSqlContainer | undefined;
let pool: pg.Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  await pool.query(createTablesSql);
});

afterAll(async () => {
  await pool.end();
  await container?.stop();
});

async function constraintRow(schema: string, name: string) {
  const { rows } = await pool.query<{ contype: string; condeferrable: boolean; condeferred: boolean }>(
    `SELECT c.contype, c.condeferrable, c.condeferred
       FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = $1 AND c.conname = $2`,
    [schema, name],
  );
  return rows[0];
}

describe('rendered exclusion constraints in PostgreSQL', () => {
  it('range-only: rejects overlapping tsranges', async () => {
    await pool.query(exclusionConstraintSql(exclude(reservation, { using: 'gist', with: [[reservation.during, '&&']] })));

    expect(await constraintRow('public', 'reservation_during_excl')).toMatchObject({ contype: 'x', condeferrable: false });
    await pool.query(`INSERT INTO reservation VALUES ('[2010-01-01 11:30, 2010-01-01 15:00)')`);
    await expect(pool.query(`INSERT INTO reservation VALUES ('[2010-01-01 14:45, 2010-01-01 15:45)')`)).rejects.toMatchObject({
      code: '23P01',
      constraint: 'reservation_during_excl',
    });
  });

  it('equality plus range: rejects the same room, allows another room', async () => {
    await pool.query(
      exclusionConstraintSql(
        exclude(roomReservation, {
          using: 'gist',
          with: [
            [roomReservation.room, '='],
            [roomReservation.during, '&&'],
          ],
        }),
      ),
    );

    expect(await constraintRow('public', 'room_reservation_room_during_excl')).toMatchObject({ contype: 'x' });
    await pool.query(`INSERT INTO room_reservation VALUES ('123A', '[2010-01-01 14:00, 2010-01-01 15:00)')`);
    await expect(
      pool.query(`INSERT INTO room_reservation VALUES ('123A', '[2010-01-01 14:30, 2010-01-01 15:30)')`),
    ).rejects.toMatchObject({ code: '23P01', constraint: 'room_reservation_room_during_excl' });
    await pool.query(`INSERT INTO room_reservation VALUES ('123B', '[2010-01-01 14:30, 2010-01-01 15:30)')`);
  });

  it('partial WHERE with tstzRange and snake_case: cancelled rows do not block the slot', async () => {
    await pool.query(
      exclusionConstraintSql(
        exclude(bookings, {
          using: 'gist',
          with: [
            [bookings.roomId, '='],
            [tstzRange(bookings.startsAt, bookings.endsAt), '&&'],
          ],
          where: sql`not ${bookings.cancelled}`,
        }),
        { casing: 'snake_case' },
      ),
    );

    const insert = (cancelled: boolean) =>
      pool.query(
        `INSERT INTO bookings (room_id, starts_at, ends_at, cancelled) VALUES ($1, '2026-03-01 10:00Z', '2026-03-01 11:00Z', $2)`,
        [ROOM, cancelled],
      );
    await insert(true);
    await insert(false);
    await expect(insert(false)).rejects.toMatchObject({ code: '23P01', constraint: 'bookings_room_id_starts_at_ends_at_excl' });
    // Back-to-back is not an overlap with [) bounds.
    await pool.query(
      `INSERT INTO bookings (room_id, starts_at, ends_at) VALUES ($1, '2026-03-01 11:00Z', '2026-03-01 12:00Z')`,
      [ROOM],
    );
  });

  it('inlined WHERE parameter: rows matching it are exempt', async () => {
    await pool.query(
      exclusionConstraintSql(
        exclude(holds, {
          name: 'holds_active',
          using: 'gist',
          with: [
            [holds.roomId, '='],
            [tstzRange(holds.startsAt, holds.endsAt), '&&'],
          ],
          where: sql`${holds.status} is distinct from ${"it's released"}`,
        }),
        { casing: 'snake_case' },
      ),
    );

    const insert = (status: string | null) =>
      pool.query(
        `INSERT INTO holds (room_id, starts_at, ends_at, status) VALUES ($1, '2026-03-01 10:00Z', '2026-03-01 11:00Z', $2)`,
        [ROOM, status],
      );
    await insert("it's released");
    await insert(null);
    await expect(insert('held')).rejects.toMatchObject({ code: '23P01', constraint: 'holds_active' });
  });

  it('custom name, schema-qualified table, deferred: the overlap fails at COMMIT', async () => {
    await pool.query(
      exclusionConstraintSql(
        exclude(archivedBookings, {
          name: 'bookings_no_overlap',
          using: 'gist',
          with: [
            [archivedBookings.roomId, '='],
            [tstzRange(archivedBookings.startsAt, archivedBookings.endsAt), '&&'],
          ],
          deferrable: 'deferred',
        }),
        { casing: 'snake_case' },
      ),
    );

    expect(await constraintRow('archive', 'bookings_no_overlap')).toMatchObject({
      contype: 'x',
      condeferrable: true,
      condeferred: true,
    });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < 2; i++) {
        await client.query(
          `INSERT INTO archive.bookings (room_id, starts_at, ends_at) VALUES ($1, '2026-03-01 10:00Z', '2026-03-01 11:00Z')`,
          [ROOM],
        );
      }
      await expect(client.query('COMMIT')).rejects.toMatchObject({ code: '23P01', constraint: 'bookings_no_overlap' });
    } finally {
      client.release();
    }
  });
});
