import { entityKind, getTableName, is, SQL } from 'drizzle-orm';
import { type AnyPgColumn, PgColumn, PgTable } from 'drizzle-orm/pg-core';

/**
 * Index methods that can back an exclusion constraint. PostgreSQL needs an
 * index method with per-row lookups, which rules out GIN and BRIN.
 *
 * @example
 * ```ts
 * const method: ExcludeIndexMethod = 'gist'; // the usual choice for ranges
 * ```
 */
export type ExcludeIndexMethod = 'gist' | 'spgist' | 'btree' | 'hash';

/**
 * Operator for one `with` pair. It must be commutative. The listed operators
 * are the common ones; any other operator name is accepted as a string.
 *
 * @example
 * ```ts
 * const sameRoom: ExcludeOperator = '=';
 * const overlaps: ExcludeOperator = '&&';
 * ```
 */
export type ExcludeOperator = '=' | '<>' | '&&' | '-|-' | '~=' | (string & {});

/**
 * Left-hand side of a `with` pair: a column of the constrained table, or a
 * `sql` expression such as a range built from two columns.
 *
 * @example
 * ```ts
 * const column: ExcludeElement<typeof bookings> = bookings.roomId;
 * const range: ExcludeElement<typeof bookings> = sql`tstzrange(${bookings.startsAt}, ${bookings.endsAt}, '[)')`;
 * ```
 */
export type ExcludeElement<TTable extends PgTable> = AnyPgColumn<{ tableName: TTable['_']['name'] }> | SQL;

/**
 * One `[element, operator]` pair. Two rows conflict when every pair's operator
 * returns true between them.
 *
 * @example
 * ```ts
 * const pair: ExcludePair<typeof bookings> = [bookings.roomId, '='];
 * ```
 */
export type ExcludePair<TTable extends PgTable> = readonly [element: ExcludeElement<TTable>, operator: ExcludeOperator];

/**
 * Configuration accepted by {@link exclude}.
 *
 * @example
 * ```ts
 * const config: ExcludeConfig<typeof bookings> = {
 *   using: 'gist',
 *   with: [
 *     [bookings.roomId, '='],
 *     [sql`tstzrange(${bookings.startsAt}, ${bookings.endsAt}, '[)')`, '&&'],
 *   ],
 * };
 * ```
 */
export interface ExcludeConfig<TTable extends PgTable> {
  /** Constraint name. At most 63 bytes, PostgreSQL's identifier limit. Defaults to `{table}_{columns}_excl` (D5). */
  name?: string;
  /** Index method backing the constraint. */
  using: ExcludeIndexMethod;
  /** At least one `[column or sql expression, operator]` pair. */
  with: readonly [ExcludePair<TTable>, ...ExcludePair<TTable>[]];
  /** Only rows matching this condition take part, e.g. `sql\`not ${table.cancelled}\``. */
  where?: SQL;
  /**
   * Makes the constraint deferrable and sets its initial mode. Leave it out for
   * a constraint checked immediately on every statement (D4).
   */
  deferrable?: 'immediate' | 'deferred';
}

/**
 * An exclusion constraint on a Drizzle table, created by {@link exclude}.
 *
 * @example
 * ```ts
 * const constraint = exclude(bookings, { using: 'gist', with: [[bookings.roomId, '=']] });
 * constraint.table === bookings; // true
 * constraint.config.using; // 'gist'
 * ```
 */
export class ExclusionConstraint<TTable extends PgTable = PgTable> {
  static readonly [entityKind]: string = 'DrizzleExcludeExclusionConstraint';

  constructor(
    readonly table: TTable,
    readonly config: ExcludeConfig<TTable>,
  ) {}
}

const INDEX_METHODS: readonly string[] = ['gist', 'spgist', 'btree', 'hash'] satisfies ExcludeIndexMethod[];
const DEFERRABLE_MODES: readonly string[] = ['immediate', 'deferred'];
const MAX_IDENTIFIER_BYTES = 63;

function fail(message: string): never {
  throw new Error(`drizzle-exclude: ${message}`);
}

function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/**
 * Defines an exclusion constraint on a Drizzle table. Export it next to the
 * table: `pgTable`'s third argument only accepts Drizzle's own builders (D18).
 *
 * Throws immediately if the configuration can't describe a valid constraint.
 *
 * @example
 * ```ts
 * import { sql } from 'drizzle-orm';
 * import { boolean, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
 * import { exclude } from 'drizzle-exclude';
 *
 * export const bookings = pgTable('bookings', {
 *   id: uuid().defaultRandom().primaryKey(),
 *   roomId: uuid().notNull(),
 *   startsAt: timestamp({ withTimezone: true }).notNull(),
 *   endsAt: timestamp({ withTimezone: true }).notNull(),
 *   cancelled: boolean().notNull().default(false),
 * });
 *
 * export const bookingsNoOverlap = exclude(bookings, {
 *   name: 'bookings_no_overlap',
 *   using: 'gist',
 *   with: [
 *     [bookings.roomId, '='],
 *     [sql`tstzrange(${bookings.startsAt}, ${bookings.endsAt}, '[)')`, '&&'],
 *   ],
 *   where: sql`not ${bookings.cancelled}`,
 * });
 * ```
 */
export function exclude<TTable extends PgTable>(table: TTable, config: ExcludeConfig<TTable>): ExclusionConstraint<TTable> {
  if (!is(table, PgTable)) {
    fail('exclude() expects a Drizzle table created with pgTable() as its first argument.');
  }
  const tableName = getTableName(table);

  const { name, using, where, deferrable } = config;
  const pairs: readonly unknown[] = config.with;

  if (name !== undefined) {
    const nameValue: unknown = name;
    if (typeof nameValue !== 'string' || nameValue.trim() === '') {
      fail(`exclude() on "${tableName}": \`name\` must be a non-empty string, or left out to use the default name.`);
    }
    const bytes = new TextEncoder().encode(nameValue).length;
    if (bytes > MAX_IDENTIFIER_BYTES) {
      fail(
        `exclude() on "${tableName}": the name "${nameValue}" is ${String(bytes)} bytes. PostgreSQL truncates names over ${String(MAX_IDENTIFIER_BYTES)} bytes, so errors would report a different name. Use a shorter name.`,
      );
    }
  }

  if (!INDEX_METHODS.includes(using)) {
    fail(
      `exclude() on "${tableName}": index method "${using}" can't back an exclusion constraint. Use 'gist' (the usual choice for ranges), 'spgist', 'btree' or 'hash'.`,
    );
  }

  if (!isArray(pairs) || pairs.length === 0) {
    fail(`exclude() on "${tableName}": \`with\` needs at least one [column or sql expression, operator] pair.`);
  }

  pairs.forEach((pair, index) => {
    const position = `\`with[${String(index)}]\``;
    if (!isArray(pair) || pair.length !== 2) {
      fail(`exclude() on "${tableName}": ${position} must be a [column or sql expression, operator] pair.`);
    }
    const [element, operator] = pair;

    if (is(element, PgColumn)) {
      if (element.table !== table) {
        fail(
          `exclude() on "${tableName}": ${position} uses column "${element.name}" from table "${getTableName(element.table)}". Every column must belong to "${tableName}".`,
        );
      }
    } else if (!is(element, SQL)) {
      fail(`exclude() on "${tableName}": ${position} must start with a column of "${tableName}" or a sql\`\` expression.`);
    }

    if (typeof operator !== 'string' || operator.trim() === '') {
      fail(`exclude() on "${tableName}": ${position} needs an operator, such as '=' or '&&'.`);
    }
  });

  if (where !== undefined && !is(where, SQL)) {
    fail(`exclude() on "${tableName}": \`where\` must be a sql\`\` expression, such as sql\`not \${table.cancelled}\`.`);
  }

  if (deferrable !== undefined && !DEFERRABLE_MODES.includes(deferrable)) {
    fail(
      `exclude() on "${tableName}": \`deferrable\` must be 'immediate' or 'deferred', or left out for a non-deferrable constraint.`,
    );
  }

  return new ExclusionConstraint(table, config);
}
