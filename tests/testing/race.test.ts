import { describe, expect, it } from 'vitest';
import { raceAttempts } from '../../src/testing/index.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('raceAttempts()', () => {
  it('runs every attempt at once and returns outcomes in attempt order', async () => {
    let running = 0;
    let mostAtOnce = 0;

    const outcome = await raceAttempts(
      async ({ index }) => {
        running += 1;
        mostAtOnce = Math.max(mostAtOnce, running);
        await tick();
        running -= 1;
        return index * 2;
      },
      { attempts: 5 },
    );

    expect(mostAtOnce).toBe(5);
    expect(outcome.values).toEqual([0, 2, 4, 6, 8]);
    expect(outcome.errors).toEqual([]);
    expect(outcome.results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled', 'fulfilled']);
  });

  it('holds every attempt at the checkpoint until all have reached it', async () => {
    const log: string[] = [];

    await raceAttempts(
      async ({ index, checkpoint }) => {
        // Later attempts reach the checkpoint later, so without the gate they'd interleave.
        for (let i = 0; i < index; i++) await tick();
        log.push(`checked ${String(index)}`);
        await checkpoint();
        log.push(`wrote ${String(index)}`);
      },
      { attempts: 4 },
    );

    expect(log.slice(0, 4).every((entry) => entry.startsWith('checked'))).toBe(true);
    expect(log.slice(4).every((entry) => entry.startsWith('wrote'))).toBe(true);
  });

  it('does not wait for an attempt that fails before its checkpoint', async () => {
    const failure = new Error('lost the connection');

    const outcome = await raceAttempts(
      async ({ index, checkpoint }) => {
        if (index === 1) throw failure;
        await checkpoint();
        return index;
      },
      { attempts: 3 },
    );

    expect(outcome.values).toEqual([0, 2]);
    expect(outcome.errors).toEqual([failure]);
    expect(outcome.results[1]).toEqual({ status: 'rejected', reason: failure });
  });

  it('runs 10 attempts by default', async () => {
    const { values } = await raceAttempts(({ index }) => Promise.resolve(index));

    expect(values).toHaveLength(10);
  });

  it.each([0, -1, 1.5])('throws immediately for attempts = %s', (attempts) => {
    let called = false;

    expect(() =>
      raceAttempts(
        () => {
          called = true;
          return Promise.resolve();
        },
        { attempts },
      ),
    ).toThrow('`attempts` must be a positive integer');
    expect(called).toBe(false);
  });
});
