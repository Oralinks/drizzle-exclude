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

function dialectFor(options: ExclusionConstraintSqlOptions): PgDialect {
  return new PgDialect(options.casing === undefined ? undefined : { casing: options.casing });
}

/** Renders SQL the way DDL needs it: bare column names with casing applied, parameters inlined. Internal. */
export function renderDdl(value: SQL, options: ExclusionConstraintSqlOptions = {}): string {
  // Wrapping in a fresh sql`` keeps the caller's own SQL objects free of inlined params.
  return dialectFor(options).sqlToQuery(sql`${value}`.inlineParams(), 'indexes').sql;
}

/** One `with` element as DDL: a bare column, or a range or other expression in parentheses. Internal. */
export function renderElement(
  element: ExcludeElement<ExclusionConstraint['table']>,
  options: ExclusionConstraintSqlOptions = {},
): string {
  if (is(element, RangeExpression)) {
    return `(${renderDdl(element.getSQL(), options)})`;
  }
  if (is(element, SQL)) {
    return `(${renderDdl(element, options)})`;
  }
  return renderDdl(sql`${element}`, options);
}

/** The constraint's table, schema-qualified when it has a schema. Internal. */
export function renderTable(constraint: ExclusionConstraint, options: ExclusionConstraintSqlOptions = {}): string {
  const dialect = dialectFor(options);
  const { name, schema } = getTableConfig(constraint.table);
  return schema === undefined ? dialect.escapeName(name) : `${dialect.escapeName(schema)}.${dialect.escapeName(name)}`;
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
  const { config } = constraint;
  const elements = config.with.map(([element, operator]) => `${renderElement(element, options)} WITH ${operator}`);
  const name = exclusionConstraintName(constraint, options);

  let statement = `ALTER TABLE ${renderTable(constraint, options)} ADD CONSTRAINT ${dialectFor(options).escapeName(name)} EXCLUDE USING ${config.using} (${elements.join(', ')})`;
  if (config.where !== undefined) {
    statement += ` WHERE (${renderDdl(config.where, options)})`;
  }
  if (config.deferrable !== undefined) {
    statement += ` DEFERRABLE INITIALLY ${config.deferrable === 'deferred' ? 'DEFERRED' : 'IMMEDIATE'}`;
  }
  return `${statement};`;
}
