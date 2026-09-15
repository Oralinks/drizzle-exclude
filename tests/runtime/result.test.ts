import { DrizzleQueryError } from 'drizzle-orm';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { catchOverlap, type ExclusionResult, parseExclusionViolation } from '../../src/index.js';
import { addedOverExistingRows, conflictingInsert } from './captured-errors.js';

/** A driver error as pg throws it: an Error carrying PostgreSQL's fields. */
const driverError = (fields: typeof conflictingInsert) => Object.assign(new Error(fields.message), fields);
const deadlock = () =>
  driverError({
    ...conflictingInsert,
    code: '40P01',
    message: 'deadlock detected',
    detail: 'Process 101 waits for ShareLock on transaction 900; blocked by process 102.',
  });

describe('catchOverlap()', () => {
  it('returns ok with the value, from a promise or a function', async () => {
    await expect(catchOverlap(Promise.resolve([{ id: 1 }]))).resolves.toEqual({ ok: true, value: [{ id: 1 }] });

    const write = vi.fn(() => Promise.resolve('row'));
    await expect(catchOverlap(write)).resolves.toEqual({ ok: true, value: 'row' });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('returns an overlap for a 23P01 conflict', async () => {
    const result = await catchOverlap(Promise.reject(driverError(conflictingInsert)));

    expect(result).toEqual({
      ok: false,
      reason: 'overlap',
      constraint: 'bookings_room_id_starts_at_ends_at_excl',
      conflictingKey: parseExclusionViolation(conflictingInsert)?.conflictingKey,
      violation: parseExclusionViolation(conflictingInsert),
    });
  });

  it('returns an overlap when Drizzle wrapped the error', async () => {
    const wrapped = new DrizzleQueryError('insert ...', [], driverError(conflictingInsert));
    const result = await catchOverlap(() => Promise.reject(wrapped));

    expect(result).toMatchObject({ ok: false, reason: 'overlap', constraint: 'bookings_room_id_starts_at_ends_at_excl' });
  });

  it('returns contention for a deadlock, raw or wrapped, keeping the error', async () => {
    const raw = deadlock();
    await expect(catchOverlap(Promise.reject(raw))).resolves.toEqual({ ok: false, reason: 'contention', error: raw });

    const wrapped = new DrizzleQueryError('insert ...', [], deadlock());
    await expect(catchOverlap(Promise.reject(wrapped))).resolves.toEqual({ ok: false, reason: 'contention', error: wrapped });
  });

  it('rethrows a failure to add a constraint over clashing rows', async () => {
    const error = driverError(addedOverExistingRows);

    await expect(catchOverlap(Promise.reject(error))).rejects.toBe(error);
  });

  it.each([
    ['a unique violation', driverError({ ...conflictingInsert, code: '23505', message: 'duplicate key value violates unique constraint "x"' })],
    ['a plain Error', new Error('connection terminated')],
    ['a non-Error value', 'boom'],
  ])('rethrows %s unchanged', async (_, error) => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- drivers can reject with non-Error values, and catchOverlap must rethrow them unchanged
    await expect(catchOverlap(Promise.reject(error))).rejects.toBe(error);
  });

  it('rethrows when the function itself throws synchronously', async () => {
    const error = new Error('bad input');

    await expect(
      catchOverlap(() => {
        throw error;
      }),
    ).rejects.toBe(error);
  });
});

describe('ExclusionResult', () => {
  it('supports an exhaustive switch with no fallthrough', () => {
    function message(result: ExclusionResult<unknown>): string {
      if (result.ok) {
        return 'Booked';
      }
      switch (result.reason) {
        case 'overlap':
          return `Taken (${result.constraint ?? 'unknown constraint'})`;
        case 'contention':
          return 'Busy, please try again';
        default: {
          const unreachable: never = result;
          return unreachable;
        }
      }
    }

    expect(message({ ok: true, value: 1 })).toBe('Booked');
    expect(message({ ok: false, reason: 'contention', error: null })).toBe('Busy, please try again');
  });

  it('narrows to the value type on success', async () => {
    const result = await catchOverlap(Promise.resolve([{ id: 'a' }]));

    if (result.ok) {
      expectTypeOf(result.value).toEqualTypeOf<{ id: string }[]>();
    }
    expectTypeOf(result).toEqualTypeOf<ExclusionResult<{ id: string }[]>>();
  });
});
