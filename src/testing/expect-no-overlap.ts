import { is, sql, type TablesRelationalConfig } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { ExclusionConstraint } from '../schema/exclude.js';
import { fail } from '../schema/fail.js';
import {
  exclusionConstraintName,
  type ExclusionConstraintSqlOptions,
  renderDdl,
  renderElement,
  renderTable,
} from '../schema/sql.js';

/**
 * Options for {@link expectNoOverlap}.
 *
 * @example
 * ```ts
 * const options: ExpectNoOverlapOptions = { casing: 'snake_case', limit: 3 };
 * ```
 */
export interface ExpectNoOverlapOptions extends ExclusionConstraintSqlOptions {
  /** How many clashing pairs the error lists. Defaults to 10. */
  limit?: number;
}

interface OverlapRow {
  first: unknown;
  second: unknown;
}

/**
 * One query that finds row pairs the constraint would reject. Each `with` element and the `WHERE`
 * are rendered as the constraint's DDL renders them, into a CTE that's joined to itself on `ctid`.
 * Internal.
 */
export function overlapQuery(constraint: ExclusionConstraint, options: ExclusionConstraintSqlOptions, limit: number): string {
  const { config } = constraint;
  const elements = config.with.map(([element], index) => `${renderElement(element, options)} AS __e${String(index)}`);
  const conditions = config.with.map(([, operator], index) => `a.__e${String(index)} ${operator} b.__e${String(index)}`);
  const included = config.where === undefined ? 'true' : `(${renderDdl(config.where, options)}) IS TRUE`;

  return [
    'WITH __candidates AS (',
    `  SELECT ctid AS __ctid, to_jsonb(__t) AS __row, ${elements.join(', ')}, ${included} AS __included`,
    `  FROM ${renderTable(constraint, options)} AS __t`,
    ')',
    'SELECT a.__row AS first, b.__row AS second',
    'FROM __candidates a JOIN __candidates b ON a.__ctid < b.__ctid',
    `WHERE a.__included AND b.__included AND ${conditions.join(' AND ')}`,
    'ORDER BY a.__ctid, b.__ctid',
    `LIMIT ${String(limit + 1)}`,
  ].join('\n');
}

/** node-postgres resolves `db.execute()` to `{ rows }`; postgres.js resolves it to an array. */
function rowsOf(result: unknown): OverlapRow[] {
  if (Array.isArray(result)) {
    return result as OverlapRow[];
  }
  if (typeof result === 'object' && result !== null && 'rows' in result && Array.isArray(result.rows)) {
    return result.rows as OverlapRow[];
  }
  return fail('expectNoOverlap(): could not read rows from db.execute(). Pass a Drizzle database for node-postgres or postgres.js.');
}

/**
 * Asserts that no two rows in a table would break an exclusion constraint. Resolves when the
 * table is clean; rejects with an `Error` listing the clashing pairs otherwise, so it works in
 * any test runner (D28).
 *
 * The constraint doesn't need to exist in the database. This checks the rows against its
 * definition, which also makes it a way to find what would stop the constraint being added.
 *
 * @example
 * ```ts
 * import { expectNoOverlap } from 'drizzle-exclude/testing';
 * import { bookingsNoOverlap } from '../src/schema';
 *
 * test('the booking flow never double-books', async () => {
 *   await runConcurrentBookings();
 *   await expectNoOverlap(db, bookingsNoOverlap, { casing: 'snake_case' });
 * });
 * ```
 */
export function expectNoOverlap<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(db: PgDatabase<TQueryResult, TFullSchema, TSchema>, constraint: ExclusionConstraint, options: ExpectNoOverlapOptions = {}): Promise<void> {
  if (!is(constraint, ExclusionConstraint)) {
    fail('expectNoOverlap() needs a constraint created with exclude().');
  }
  const { limit = 10, ...sqlOptions } = options;
  const limitValue: unknown = limit;
  if (typeof limitValue !== 'number' || !Number.isInteger(limitValue) || limitValue < 1) {
    fail(`expectNoOverlap(): \`limit\` must be a positive integer, not ${JSON.stringify(limitValue)}.`);
  }

  const name = exclusionConstraintName(constraint, sqlOptions);
  const table = renderTable(constraint, sqlOptions);
  const query = overlapQuery(constraint, sqlOptions, limit);

  return (async () => {
    const pairs = rowsOf(await db.execute(sql.raw(query)));
    if (pairs.length === 0) {
      return;
    }
    const found =
      pairs.length > limit
        ? `more than ${String(limit)} clashing pairs. The first ${String(limit)}`
        : `${String(pairs.length)} clashing ${pairs.length === 1 ? 'pair' : 'pairs'}`;
    throw new Error(
      [
        `drizzle-exclude: expected no rows in ${table} to break exclusion constraint "${name}", but found ${found}:`,
        ...pairs.slice(0, limit).map((pair) => `  ${JSON.stringify(pair.first)} clashes with ${JSON.stringify(pair.second)}`),
      ].join('\n'),
    );
  })();
}
