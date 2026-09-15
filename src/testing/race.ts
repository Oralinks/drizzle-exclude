import { fail } from '../schema/fail.js';

/**
 * What each attempt receives from {@link raceAttempts}.
 *
 * @example
 * ```ts
 * await raceAttempts(async ({ index, checkpoint }) => {
 *   const free = await isSlotFree(slot);
 *   await checkpoint(); // every attempt has checked before any of them books
 *   return free ? book(slot, `guest ${index}`) : 'taken';
 * });
 * ```
 */
export interface Attempt {
  /** This attempt's position, from 0. */
  readonly index: number;
  /**
   * Waits until every other attempt has reached its checkpoint too, or finished without
   * reaching one, then lets them all continue together. Put it between a check and the write
   * that depends on it to force the worst-case interleaving deterministically.
   */
  readonly checkpoint: () => Promise<void>;
}

/**
 * Options for {@link raceAttempts}.
 *
 * @example
 * ```ts
 * const options: RaceOptions = { attempts: 20 };
 * ```
 */
export interface RaceOptions {
  /** How many attempts run at once. Defaults to 10. */
  attempts?: number;
}

/**
 * Every attempt's outcome, in attempt order.
 *
 * @example
 * ```ts
 * const { values, errors } = await raceAttempts(() => catchOverlap(bookSlot()));
 * expect(values.filter((result) => result.ok)).toHaveLength(1);
 * expect(errors).toEqual([]);
 * ```
 */
export interface RaceOutcome<T> {
  /** One settled result per attempt. */
  readonly results: readonly PromiseSettledResult<T>[];
  /** The values of the attempts that resolved. */
  readonly values: readonly T[];
  /** The reasons of the attempts that rejected. */
  readonly errors: readonly unknown[];
}

/**
 * Runs the same attempt many times at once, for testing what your code and database do under
 * concurrency. Every attempt starts together; use the `checkpoint` it receives to line them up
 * at the most dangerous moment. Never rejects: each attempt's outcome is collected (D29).
 *
 * @example
 * ```ts
 * import { catchOverlap } from 'drizzle-exclude';
 * import { expectNoOverlap, raceAttempts } from 'drizzle-exclude/testing';
 *
 * test('ten guests booking the same room at once get exactly one booking', async () => {
 *   const { values } = await raceAttempts(() =>
 *     catchOverlap(db.insert(bookings).values({ roomId, startsAt, endsAt })),
 *   );
 *
 *   expect(values.filter((result) => result.ok)).toHaveLength(1);
 *   await expectNoOverlap(db, bookingsNoOverlap);
 * });
 * ```
 */
export function raceAttempts<T>(attempt: (attempt: Attempt) => Promise<T>, options: RaceOptions = {}): Promise<RaceOutcome<T>> {
  const { attempts = 10 } = options;
  const count: unknown = attempts;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) {
    fail(`raceAttempts(): \`attempts\` must be a positive integer, not ${JSON.stringify(count)}.`);
  }

  let waiting = 0;
  let finishedEarly = 0;
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const openWhenAllAccountedFor = () => {
    if (waiting + finishedEarly === attempts) {
      open();
    }
  };

  const runs = Array.from({ length: attempts }, async (_, index) => {
    // An object, so TypeScript doesn't assume the flag is still false after the attempt has run.
    const progress = { reachedCheckpoint: false };
    const checkpoint = () => {
      if (!progress.reachedCheckpoint) {
        progress.reachedCheckpoint = true;
        waiting += 1;
        openWhenAllAccountedFor();
      }
      return gate;
    };
    try {
      return await attempt({ index, checkpoint });
    } finally {
      if (!progress.reachedCheckpoint) {
        finishedEarly += 1;
        openWhenAllAccountedFor();
      }
    }
  });

  return Promise.allSettled(runs).then((results) => ({
    results,
    values: results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : [])),
    errors: results.flatMap((result) => (result.status === 'rejected' ? [result.reason as unknown] : [])),
  }));
}
