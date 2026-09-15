import type { SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { integer, PgDialect, pgSchema, pgTable, text } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { exclude, int4Range, withDeferredConstraints } from '../../src/index.js';
import { conflictingInsert } from './captured-errors.js';

const slotColumns = () => ({
  id: text().primaryKey(),
  room: integer().notNull(),
  firstSlot: integer().notNull(),
  lastSlot: integer().notNull(),
});
const slots = pgTable('slots', slotColumns());
const archivedSlots = pgSchema('archive').table('slots', slotColumns());

const slotsNoOverlap = exclude(slots, {
  name: 'slots_no_overlap',
  using: 'gist',
  with: [
    [slots.room, '='],
    [int4Range(slots.firstSlot, slots.lastSlot), '&&'],
  ],
  deferrable: 'immediate',
});
const archivedNoOverlap = exclude(archivedSlots, {
  using: 'gist',
  with: [
    [archivedSlots.room, '='],
    [int4Range(archivedSlots.firstSlot, archivedSlots.lastSlot), '&&'],
  ],
  deferrable: 'deferred',
});
const slotsStrict = exclude(slots, { name: 'slots_strict', using: 'gist', with: [[slots.room, '=']] });

/** A stand-in for a Drizzle database that records the SQL run inside the transaction. */
function fakeDatabase(commit: () => Promise<void> = () => Promise.resolve()) {
  const dialect = new PgDialect();
  const executed: string[] = [];
  const tx = {
    execute: vi.fn((query: SQL) => {
      executed.push(dialect.sqlToQuery(query).sql);
      return Promise.resolve();
    }),
  };
  const transaction = vi.fn(async (work: (transaction: typeof tx) => Promise<unknown>) => {
    const value = await work(tx);
    await commit();
    return value;
  });
  return { db: { transaction } as unknown as NodePgDatabase, executed, transaction };
}

describe('withDeferredConstraints()', () => {
  it('defers each constraint once, schema-qualified where needed, then runs the work', async () => {
    const { db, executed } = fakeDatabase();

    const result = await withDeferredConstraints(db, [slotsNoOverlap, archivedNoOverlap, slotsNoOverlap], () => Promise.resolve('moved'), {
      casing: 'snake_case',
    });

    expect(result).toEqual({ ok: true, value: 'moved' });
    expect(executed).toEqual(['set constraints "slots_no_overlap", "archive"."slots_room_first_slot_last_slot_excl" deferred']);
  });

  it('returns an overlap when COMMIT finds the final rows still clash', async () => {
    const commitError = Object.assign(new Error(conflictingInsert.message), conflictingInsert);
    const { db } = fakeDatabase(() => Promise.reject(commitError));

    const result = await withDeferredConstraints(db, [slotsNoOverlap], () => Promise.resolve('moved'));

    expect(result).toMatchObject({ ok: false, reason: 'overlap', constraint: 'bookings_room_id_starts_at_ends_at_excl' });
  });

  it('throws immediately for a constraint that is not deferrable, before any transaction', () => {
    const { db, transaction } = fakeDatabase();

    expect(() => withDeferredConstraints(db, [slotsNoOverlap, slotsStrict], () => Promise.resolve())).toThrow(
      `constraint "slots_strict" is not deferrable, and PostgreSQL can only defer constraints declared DEFERRABLE (42809). Add deferrable: 'immediate'`,
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it('throws immediately for an empty list', () => {
    const { db, transaction } = fakeDatabase();

    expect(() => withDeferredConstraints(db, [], () => Promise.resolve())).toThrow('needs a non-empty array of constraints');
    expect(transaction).not.toHaveBeenCalled();
  });
});
