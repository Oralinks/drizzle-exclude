import { errorWithCode, type ExclusionKey, type ExclusionViolation, parseExclusionViolation } from './violation.js';

/** SQLSTATE PostgreSQL raises when it aborts a transaction to break a deadlock. */
const DEADLOCK_DETECTED = '40P01';

/**
 * The write went through.
 *
 * @example
 * ```ts
 * const result = await catchOverlap(db.insert(bookings).values(slot).returning());
 * if (result.ok) console.log(result.value[0]?.id);
 * ```
 */
export interface ExclusionSuccess<T> {
  readonly ok: true;
  /** Whatever the write resolved to, such as the rows from `.returning()`. */
  readonly value: T;
}

/**
 * PostgreSQL rejected the write because it would break an exclusion constraint: the slot is taken.
 *
 * @example
 * ```ts
 * if (!result.ok && result.reason === 'overlap') {
 *   console.log(result.constraint, result.conflictingKey?.existing);
 * }
 * ```
 */
export interface ExclusionOverlap {
  readonly ok: false;
  readonly reason: 'overlap';
  readonly constraint: string | undefined;
  readonly conflictingKey: ExclusionKey | undefined;
  /** The full parsed error. */
  readonly violation: ExclusionViolation;
}

/**
 * PostgreSQL aborted the write to break a deadlock (SQLSTATE `40P01`). Conflicting writes that
 * arrive at the same instant can deadlock on an exclusion constraint instead of raising `23P01`.
 * It doesn't mean the slot is taken: sometimes every contender deadlocks and nobody books. Retry
 * the whole unit of work if that suits your flow (D25).
 *
 * @example
 * ```ts
 * if (!result.ok && result.reason === 'contention') {
 *   console.log('Busy, please try again');
 * }
 * ```
 */
export interface ExclusionContention {
  readonly ok: false;
  readonly reason: 'contention';
  /** The error PostgreSQL raised, as the driver or Drizzle threw it. */
  readonly error: unknown;
}

/**
 * Outcome of {@link catchOverlap}. Check `ok`, then `reason`; a `switch` on `reason` is exhaustive.
 *
 * @example
 * ```ts
 * function message(result: ExclusionResult<unknown>): string {
 *   if (result.ok) return 'Booked';
 *   switch (result.reason) {
 *     case 'overlap':
 *       return 'That room is already booked for this time';
 *     case 'contention':
 *       return 'Busy, please try again';
 *   }
 * }
 * ```
 */
export type ExclusionResult<T> = ExclusionSuccess<T> | ExclusionOverlap | ExclusionContention;

/**
 * Runs a write and returns its outcome instead of throwing for the outcomes a booking flow
 * expects: an exclusion-constraint overlap (`23P01`) or a deadlock under contention (`40P01`).
 * Any other error, including a failure to add a constraint over clashing rows, is rethrown
 * unchanged. It never retries on its own (D25).
 *
 * Pass a Drizzle query, or a function that returns one. Errors are found whether they come
 * straight from the driver or wrapped in Drizzle's `DrizzleQueryError`.
 *
 * @example
 * ```ts
 * import { catchOverlap } from 'drizzle-exclude';
 *
 * async function createBooking(roomId: string, startsAt: Date, endsAt: Date) {
 *   const result = await catchOverlap(
 *     db.insert(bookings).values({ roomId, startsAt, endsAt }).returning(),
 *   );
 *
 *   if (!result.ok) {
 *     return result.reason === 'overlap'
 *       ? { status: 409, body: 'That room is already booked for this time' }
 *       : { status: 503, body: 'Busy, please try again' };
 *   }
 *   return { status: 201, body: result.value[0] };
 * }
 * ```
 */
export async function catchOverlap<T>(write: PromiseLike<T> | (() => PromiseLike<T>)): Promise<ExclusionResult<T>> {
  try {
    const value = await (typeof write === 'function' ? write() : write);
    return { ok: true, value };
  } catch (error) {
    const violation = parseExclusionViolation(error);
    if (violation?.kind === 'conflict') {
      return {
        ok: false,
        reason: 'overlap',
        constraint: violation.constraint,
        conflictingKey: violation.conflictingKey,
        violation,
      };
    }
    if (errorWithCode(error, DEADLOCK_DETECTED) !== undefined) {
      return { ok: false, reason: 'contention', error };
    }
    throw error;
  }
}
