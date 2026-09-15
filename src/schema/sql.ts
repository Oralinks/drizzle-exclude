import { type Casing, is, SQL, sql } from 'drizzle-orm';
import { CasingCache } from 'drizzle-orm/casing';
import { type AnyPgColumn, getTableConfig, PgColumn, PgDialect } from 'drizzle-orm/pg-core';
import type { ExcludeElement, ExclusionConstraint } from './exclude.js';
import { fail } from './fail.js';
import { identifierBytes, MAX_IDENTIFIER_BYTES } from './identifiers.js';
import { RangeExpression } from './ranges.js';

/**
 * Options for {@link exclusionConstraintSql}.
 *
 * @example
 * ```ts
 * // Same casing as drizzle({ casing: 'snake_case' }) and drizzle-kit's config.
 * const options: ExclusionConstraintSqlOptions = { casing: 'snake_case' };
 * ```
 */
export interface ExclusionConstraintSqlOptions {
  /** Must match the `casing` passed to `drizzle()` and drizzle-kit. It decides the column names in the SQL. */
  casing?: Casing;
}

function collectColumns(chunks: readonly unknown[], into: AnyPgColumn[]): void {
  for (const chunk of chunks) {
    if (is(chunk, PgColumn)) {
      into.push(chunk);
    } else if (is(chunk, RangeExpression)) {
      into.push(...chunk.columns);
    } else if (is(chunk, SQL)) {
      collectColumns(chunk.queryChunks, into);
    } else if (Array.isArray(chunk)) {
      collectColumns(chunk, into);
    }
  }
}

function columnsOf(element: ExcludeElement<ExclusionConstraint['table']>): AnyPgColumn[] {
  const columns: AnyPgColumn[] = [];
  collectColumns([element], columns);
  return columns;
}

/**
 * The constraint's name: its `name`, or D5's default `{table}_{columns}_excl`, built from the
 * database names of the columns in `with`. Internal; not exported from the package entry point.
 */
export function exclusionConstraintName(
  constraint: ExclusionConstraint,
  options: ExclusionConstraintSqlOptions = {},
): string {
  const { config, table } = constraint;
  if (config.name !== undefined) {
    return config.name;
  }

  const casingCache = new CasingCache(options.casing);
  // `with` columns only, like PostgreSQL's own naming; WHERE columns don't count.
  const referenced = new Set<string>();
  for (const [element] of config.with) {
    for (const column of columnsOf(element)) {
      referenced.add(casingCache.getColumnCasing(column));
    }
  }

  const name = [getTableConfig(table).name, ...referenced, 'excl'].join('_');
  const bytes = identifierBytes(name);
  if (bytes > MAX_IDENTIFIER_BYTES) {
    fail(
      `the default constraint name "${name}" is ${String(bytes)} bytes, over PostgreSQL's ${String(MAX_IDENTIFIER_BYTES)}-byte limit. Pass a shorter \`name\` to exclude().`,
    );
  }
  return name;
}

/**
 * Renders an exclusion constraint as one `ALTER TABLE … ADD CONSTRAINT … EXCLUDE …;` statement,
 * ready to paste into a `drizzle-kit generate --custom` migration. drizzle-kit can't emit
 * exclusion constraints itself (D18). To also handle `btree_gist`, use {@link exclusionMigrationSql}.
 *
 * Columns are written without their table name, with `casing` applied. Ranges and other
 * expressions are wrapped in parentheses, and query parameters are inlined, because DDL
 * can't take parameters. Without a `name`, the constraint is called
 * `{table}_{columns}_excl` (D5), which throws if that's longer than 63 bytes.
 *
 * @example
 * ```ts
 * import { exclusionConstraintSql } from 'drizzle-exclude';
 * import { bookingsNoOverlap } from './schema';
 *
 * console.log(exclusionConstraintSql(bookingsNoOverlap, { casing: 'snake_case' }));
 * // ALTER TABLE "bookings" ADD CONSTRAINT "bookings_room_id_starts_at_ends_at_excl"
 * //   EXCLUDE USING gist ("room_id" WITH =, (tstzrange("starts_at", "ends_at", '[)')) WITH &&)
 * //   WHERE (not "cancelled");
 * ```
 */
export function exclusionConstraintSql(
  constraint: ExclusionConstraint,
  options: ExclusionConstraintSqlOptions = {},
): string {
  const { casing } = options;
  const dialect = new PgDialect(casing === undefined ? undefined : { casing });
  const { config, table } = constraint;
  const { name: tableName, schema } = getTableConfig(table);

  // Wrapping in a fresh sql`` keeps the caller's own SQL objects free of inlined params.
  const render = (value: SQL): string => dialect.sqlToQuery(sql`${value}`.inlineParams(), 'indexes').sql;

  const elements = config.with.map(([element, operator]) => {
    if (is(element, RangeExpression)) {
      return `(${render(element.getSQL())}) WITH ${operator}`;
    }
    if (is(element, SQL)) {
      return `(${render(element)}) WITH ${operator}`;
    }
    return `${render(sql`${element}`)} WITH ${operator}`;
  });

  const name = exclusionConstraintName(constraint, options);
  const target =
    schema === undefined ? dialect.escapeName(tableName) : `${dialect.escapeName(schema)}.${dialect.escapeName(tableName)}`;

  let statement = `ALTER TABLE ${target} ADD CONSTRAINT ${dialect.escapeName(name)} EXCLUDE USING ${config.using} (${elements.join(', ')})`;
  if (config.where !== undefined) {
    statement += ` WHERE (${render(config.where)})`;
  }
  if (config.deferrable !== undefined) {
    statement += ` DEFERRABLE INITIALLY ${config.deferrable === 'deferred' ? 'DEFERRED' : 'IMMEDIATE'}`;
  }
  return `${statement};`;
}
