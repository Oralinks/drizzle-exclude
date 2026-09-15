import { is, type SQL, sql, type TablesRelationalConfig } from 'drizzle-orm';
import { getTableConfig, type PgDatabase, type PgQueryResultHKT, type PgTransaction } from 'drizzle-orm/pg-core';
import { ExclusionConstraint } from '../schema/exclude.js';
import { fail } from '../schema/fail.js';
import { exclusionConstraintName, type ExclusionConstraintSqlOptions } from '../schema/sql.js';
import { catchOverlap, type ExclusionResult } from './result.js';

/** `set constraints <names> deferred`, with each name schema-qualified when its table has a schema. */
function setConstraintsDeferred(constraints: readonly ExclusionConstraint[], options: ExclusionConstraintSqlOptions): SQL {
  const names = new Map<string, SQL>();
  for (const constraint of constraints) {
    const name = exclusionConstraintName(constraint, options);
    const { schema } = getTableConfig(constraint.table);
    const key = `${schema ?? ''}.${name}`;
    if (!names.has(key)) {
      names.set(
        key,
        schema === undefined ? sql`${sql.identifier(name)}` : sql`${sql.identifier(schema)}.${sql.identifier(name)}`,
      );
    }
  }
  return sql`set constraints ${sql.join([...names.values()], sql`, `)} deferred`;
}

/**
 * Runs `work` in a transaction with the given exclusion constraints deferred to `COMMIT`, so
 * rows can pass through overlapping states on the way to a valid end state, such as bookings
 * swapping slots in a cycle (D4, D27). If the end state still overlaps, `COMMIT` fails and the
 * result is `'overlap'`. Returns the same result as {@link catchOverlap}, and never retries.
 *
 * Every constraint must be declared with `deferrable` in `exclude()`; PostgreSQL can't defer
 * the others. That, or an empty list, throws immediately, before any transaction starts.
 *
 * @example
 * ```ts
 * import { eq } from 'drizzle-orm';
 * import { withDeferredConstraints } from 'drizzle-exclude';
 *
 * // bookingsNoOverlap was declared with deferrable: 'immediate'.
 * const result = await withDeferredConstraints(db, [bookingsNoOverlap], async (tx) => {
 *   await tx.update(bookings).set({ roomId: roomB }).where(eq(bookings.id, first));
 *   await tx.update(bookings).set({ roomId: roomA }).where(eq(bookings.id, second));
 *   return 'swapped';
 * }, { casing: 'snake_case' });
 *
 * if (!result.ok) console.log(result.reason); // 'overlap' if the final arrangement still clashes
 * ```
 */
export function withDeferredConstraints<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
  T,
>(
  db: PgDatabase<TQueryResult, TFullSchema, TSchema>,
  constraints: readonly ExclusionConstraint[],
  work: (tx: PgTransaction<TQueryResult, TFullSchema, TSchema>) => Promise<T>,
  options: ExclusionConstraintSqlOptions = {},
): Promise<ExclusionResult<T>> {
  const list: readonly unknown[] = constraints;
  if (list.length === 0 || !list.every((constraint) => is(constraint, ExclusionConstraint))) {
    fail('withDeferredConstraints() needs a non-empty array of constraints created with exclude().');
  }

  const notDeferrable = constraints
    .filter((constraint) => constraint.config.deferrable === undefined)
    .map((constraint) => `"${exclusionConstraintName(constraint, options)}"`);
  if (notDeferrable.length > 0) {
    const subject =
      notDeferrable.length === 1 ? `constraint ${notDeferrable.join('')} is` : `constraints ${notDeferrable.join(', ')} are`;
    fail(
      `withDeferredConstraints(): ${subject} not deferrable, and PostgreSQL can only defer constraints declared DEFERRABLE (42809). Add deferrable: 'immediate' to the exclude() config, then drop and re-add the constraint in a migration.`,
    );
  }

  return catchOverlap(() =>
    db.transaction(async (tx) => {
      await tx.execute(setConstraintsDeferred(constraints, options));
      return work(tx);
    }),
  );
}
