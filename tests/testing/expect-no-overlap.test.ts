import { type SQL, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { exclude, tstzRange } from '../../src/index.js';
import { expectNoOverlap } from '../../src/testing/index.js';
import { archivedBookings, bookings } from '../schema/fixtures.js';

const bookingsNoOverlap = exclude(bookings, {
  using: 'gist',
  with: [
    [bookings.roomId, '='],
    [tstzRange(bookings.startsAt, bookings.endsAt), '&&'],
  ],
  where: sql`not ${bookings.cancelled}`,
});

/** A stand-in for a Drizzle database whose execute() records the SQL and resolves to `result`. */
function fakeDatabase(result: unknown) {
  const dialect = new PgDialect();
  const executed: string[] = [];
  const execute = vi.fn((query: SQL) => {
    executed.push(dialect.sqlToQuery(query).sql);
    return Promise.resolve(result);
  });
  return { db: { execute } as unknown as NodePgDatabase, executed, execute };
}

const pair = (first: number, second: number) => ({ first: { id: first }, second: { id: second } });

describe('expectNoOverlap()', () => {
  it('runs one self-join over the rendered constraint (hand-written expected SQL)', async () => {
    const { db, executed } = fakeDatabase({ rows: [] });

    await expectNoOverlap(db, bookingsNoOverlap, { casing: 'snake_case' });

    expect(executed).toEqual([
      [
        'WITH __candidates AS (',
        `  SELECT ctid AS __ctid, to_jsonb(__t) AS __row, "room_id" AS __e0, (tstzrange("starts_at", "ends_at", '[)')) AS __e1, (not "cancelled") IS TRUE AS __included`,
        '  FROM "bookings" AS __t',
        ')',
        'SELECT a.__row AS first, b.__row AS second',
        'FROM __candidates a JOIN __candidates b ON a.__ctid < b.__ctid',
        'WHERE a.__included AND b.__included AND a.__e0 = b.__e0 AND a.__e1 && b.__e1',
        'ORDER BY a.__ctid, b.__ctid',
        'LIMIT 11',
      ].join('\n'),
    ]);
  });

  it('includes every row when the constraint has no WHERE, and qualifies the schema', async () => {
    const { db, executed } = fakeDatabase([]);
    const constraint = exclude(archivedBookings, { using: 'gist', with: [[archivedBookings.roomId, '=']] });

    await expectNoOverlap(db, constraint, { casing: 'snake_case', limit: 2 });

    expect(executed[0]).toContain(`, true AS __included\n  FROM "archive"."bookings" AS __t`);
    expect(executed[0]).toMatch(/LIMIT 3$/);
  });

  it.each([
    ['node-postgres', { rows: [] }],
    ['postgres.js', []],
  ])('resolves when there are no clashing rows (%s result shape)', async (_, result) => {
    await expect(expectNoOverlap(fakeDatabase(result).db, bookingsNoOverlap)).resolves.toBeUndefined();
  });

  it.each([
    ['node-postgres', { rows: [pair(1, 2), pair(2, 3)] }],
    ['postgres.js', [pair(1, 2), pair(2, 3)]],
  ])('rejects listing each clashing pair (%s result shape)', async (_, result) => {
    await expect(expectNoOverlap(fakeDatabase(result).db, bookingsNoOverlap, { casing: 'snake_case' })).rejects.toThrow(
      [
        'drizzle-exclude: expected no rows in "bookings" to break exclusion constraint "bookings_room_id_starts_at_ends_at_excl", but found 2 clashing pairs:',
        '  {"id":1} clashes with {"id":2}',
        '  {"id":2} clashes with {"id":3}',
      ].join('\n'),
    );
  });

  it('says "pair" for one, and "more than" when the limit cuts the list short', async () => {
    await expect(expectNoOverlap(fakeDatabase([pair(1, 2)]).db, bookingsNoOverlap)).rejects.toThrow('but found 1 clashing pair:');

    await expect(
      expectNoOverlap(fakeDatabase([pair(1, 2), pair(2, 3)]).db, bookingsNoOverlap, { limit: 1 }),
    ).rejects.toThrow(/found more than 1 clashing pairs\. The first 1:\n {2}\{"id":1\} clashes with \{"id":2\}$/);
  });

  it('throws immediately for a limit that is not a positive integer, before querying', () => {
    const { db, execute } = fakeDatabase([]);

    expect(() => expectNoOverlap(db, bookingsNoOverlap, { limit: 0 })).toThrow('`limit` must be a positive integer, not 0');
    expect(execute).not.toHaveBeenCalled();
  });

  it('throws immediately when given something that is not a constraint', () => {
    const { db, execute } = fakeDatabase([]);

    // @ts-expect-error the second argument must come from exclude()
    expect(() => expectNoOverlap(db, bookings)).toThrow('needs a constraint created with exclude()');
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects when db.execute() resolves to something it cannot read', async () => {
    await expect(expectNoOverlap(fakeDatabase({ unexpected: true }).db, bookingsNoOverlap)).rejects.toThrow(
      'could not read rows from db.execute()',
    );
  });
});
