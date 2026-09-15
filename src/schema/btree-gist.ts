import { is } from 'drizzle-orm';
import { PgColumn } from 'drizzle-orm/pg-core';
import { ExclusionConstraint } from './exclude.js';
import { fail } from './fail.js';
import { RangeExpression } from './ranges.js';
import { exclusionConstraintName, exclusionConstraintSql, type ExclusionConstraintSqlOptions } from './sql.js';

/** drizzle-kit's separator between statements in a migration file; drizzle-orm's migrator splits on it. */
const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

// Types whose default GiST operator classes ship with PostgreSQL itself, so they never need btree_gist.
const CORE_GIST_TYPE = /(?:range|multirange)$|^(?:point|box|circle|polygon|tsvector|tsquery)$/;

/**
 * Whether a constraint needs the `btree_gist` extension. Without it, GiST can only compare
 * ranges and a few geometric types, so `room_id WITH =` on a `uuid` fails with
 * `data type uuid has no default operator class for access method "gist"`.
 *
 * True for a `gist` constraint with any `with` element that isn't a range. A `sql` expression
 * counts too: its type is unknown, and an unneeded `CREATE EXTENSION IF NOT EXISTS` is harmless.
 *
 * @example
 * ```ts
 * needsBtreeGist(exclude(bookings, { using: 'gist', with: [[bookings.roomId, '='], [during, '&&']] })); // true
 * needsBtreeGist(exclude(bookings, { using: 'gist', with: [[during, '&&']] })); // false
 * ```
 */
export function needsBtreeGist(constraint: ExclusionConstraint): boolean {
  if (constraint.config.using !== 'gist') {
    return false;
  }
  return constraint.config.with.some(([element]) => {
    if (is(element, RangeExpression)) {
      return false;
    }
    if (is(element, PgColumn)) {
      return !CORE_GIST_TYPE.test(element.getSQLType().toLowerCase());
    }
    return true;
  });
}

/**
 * The statement that installs `btree_gist`. The package never runs it for you (D8).
 *
 * @example
 * ```ts
 * btreeGistSql(); // 'CREATE EXTENSION IF NOT EXISTS btree_gist;'
 * ```
 */
export function btreeGistSql(): string {
  return 'CREATE EXTENSION IF NOT EXISTS btree_gist;';
}

/**
 * Options for {@link exclusionMigrationSql}.
 *
 * @example
 * ```ts
 * // Supabase: btree_gist is enabled from the dashboard, so only check for it.
 * const options: ExclusionMigrationSqlOptions = { casing: 'snake_case', btreeGist: 'require' };
 * ```
 */
export interface ExclusionMigrationSqlOptions extends ExclusionConstraintSqlOptions {
  /**
   * What the migration does when a constraint needs `btree_gist`.
   *
   * - `'create'` (default): starts with `CREATE EXTENSION IF NOT EXISTS btree_gist;`.
   * - `'require'`: starts with a check that stops the migration, with a message saying what to
   *   add, if `btree_gist` isn't installed. For hosts where extensions are enabled outside migrations.
   */
  btreeGist?: 'create' | 'require';
}

function stringLiteral(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

function requireBtreeGistSql(names: readonly string[]): string {
  const subject =
    names.length === 1
      ? `exclusion constraint "${names[0] ?? ''}" needs`
      : `exclusion constraints ${names.map((name) => `"${name}"`).join(', ')} need`;
  const message = `drizzle-exclude: ${subject} the btree_gist extension, which is not installed in this database.`;
  const hint =
    'Add CREATE EXTENSION IF NOT EXISTS btree_gist; at the top of this migration, or enable btree_gist for the database before running it (on Supabase: Database > Extensions).';

  return [
    'DO $drizzle_exclude$',
    'BEGIN',
    "  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist') THEN",
    // RAISE treats % as a placeholder in the message, so escape it there.
    `    RAISE EXCEPTION ${stringLiteral(message.replaceAll('%', '%%'))} USING HINT = ${stringLiteral(hint)};`,
    '  END IF;',
    'END',
    '$drizzle_exclude$;',
  ].join('\n');
}

/**
 * Renders a whole `drizzle-kit generate --custom` migration for one or more exclusion
 * constraints. Statements are separated by drizzle-kit's `--> statement-breakpoint`, and
 * `btree_gist` is handled first when any constraint needs it (D23).
 *
 * @example
 * ```ts
 * import { exclusionMigrationSql } from 'drizzle-exclude';
 * import { bookingsNoOverlap } from './schema';
 *
 * console.log(exclusionMigrationSql([bookingsNoOverlap], { casing: 'snake_case' }));
 * // CREATE EXTENSION IF NOT EXISTS btree_gist;
 * // --> statement-breakpoint
 * // ALTER TABLE "bookings" ADD CONSTRAINT "bookings_room_id_starts_at_ends_at_excl" EXCLUDE USING gist (…);
 * ```
 */
export function exclusionMigrationSql(
  constraints: readonly ExclusionConstraint[],
  options: ExclusionMigrationSqlOptions = {},
): string {
  const { btreeGist = 'create', ...sqlOptions } = options;
  const list: readonly unknown[] = constraints;

  if (list.length === 0 || !list.every((constraint) => is(constraint, ExclusionConstraint))) {
    fail('exclusionMigrationSql() needs a non-empty array of constraints created with exclude().');
  }
  const mode: unknown = btreeGist;
  if (mode !== 'create' && mode !== 'require') {
    fail(`exclusionMigrationSql(): \`btreeGist\` must be 'create' or 'require', not ${JSON.stringify(mode)}.`);
  }

  const statements = constraints.map((constraint) => exclusionConstraintSql(constraint, sqlOptions));
  const needing = constraints.filter((constraint) => needsBtreeGist(constraint));
  if (needing.length > 0) {
    statements.unshift(
      btreeGist === 'create'
        ? btreeGistSql()
        : requireBtreeGistSql(needing.map((constraint) => exclusionConstraintName(constraint, sqlOptions))),
    );
  }
  return statements.join(`\n${STATEMENT_BREAKPOINT}\n`);
}
