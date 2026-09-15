/** SQLSTATE PostgreSQL raises when a row breaks an exclusion constraint. */
const EXCLUSION_VIOLATION = '23P01';

const KEY_PREFIX = 'Key (';
const DETAIL_END = ').';

/**
 * The conflicting rows from an exclusion violation's `DETAIL`, as PostgreSQL printed them.
 *
 * @example
 * ```ts
 * const key: ExclusionKey = {
 *   columns: ['room_id', "tstzrange(starts_at, ends_at, '[)'::text)"],
 *   attempted: '11111111-…, ["2026-03-01 10:30:00+00","2026-03-01 11:30:00+00")',
 *   existing: '11111111-…, ["2026-03-01 10:00:00+00","2026-03-01 11:00:00+00")',
 * };
 * ```
 */
export interface ExclusionKey {
  /** One entry per constraint element: a column name, or an expression as PostgreSQL deparsed it. */
  readonly columns: readonly string[];
  /**
   * The rejected row's values, as a single string. Not split per column: PostgreSQL prints values
   * raw, so a text value can itself contain commas, brackets and quotes. Timestamps follow the
   * session's `TimeZone`.
   */
  readonly attempted: string;
  /** The values of the row it conflicts with, in the same form. */
  readonly existing: string;
}

/**
 * A parsed SQLSTATE `23P01` error.
 *
 * @example
 * ```ts
 * const violation = parseExclusionViolation(error);
 * if (violation?.constraint === 'bookings_room_id_starts_at_ends_at_excl') {
 *   // the room is already booked for that time
 * }
 * ```
 */
export interface ExclusionViolation {
  /** `'conflict'` when a write was rejected; `'existing-rows'` when adding the constraint failed because rows already clash. */
  readonly kind: 'conflict' | 'existing-rows';
  /** Constraint name, from the error's constraint field or, failing that, its message. */
  readonly constraint: string | undefined;
  readonly table: string | undefined;
  readonly schema: string | undefined;
  /**
   * The conflicting key, or `undefined` when `DETAIL` leaves it out (PostgreSQL does for roles
   * without `SELECT` on the table, and under row-level security) or has an unexpected shape.
   */
  readonly conflictingKey: ExclusionKey | undefined;
  /** The raw `DETAIL`, if any. */
  readonly detail: string | undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

const MAX_CAUSE_DEPTH = 5;

/**
 * The error carrying PostgreSQL's fields for `code`: the error itself, or one of its causes.
 * Drizzle wraps driver errors in `DrizzleQueryError`, keeping the original as `cause`. Internal.
 */
export function errorWithCode(error: unknown, code: string): Record<string, unknown> | undefined {
  let current: unknown = error;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    const fields = current as Record<string, unknown>;
    if (fields.code === code) {
      return fields;
    }
    current = fields.cause;
  }
  return undefined;
}

/** Index of the quote closing the quoted run starting at `start`, treating doubled quotes as escapes. */
function skipQuoted(source: string, start: number): number | undefined {
  const quote = source[start];
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === quote) {
      if (source[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i;
    }
    i += 1;
  }
  return undefined;
}

/** Index of the `)` matching the `(` at `open`, skipping quoted literals and identifiers. */
function closingParen(source: string, open: number): number | undefined {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const char = source[i];
    if (char === "'" || char === '"') {
      const end = skipQuoted(source, i);
      if (end === undefined) {
        return undefined;
      }
      i = end;
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return undefined;
}

/** Splits a deparsed element list on commas that aren't inside parentheses or quotes. */
function splitElements(source: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === "'" || char === '"') {
      const end = skipQuoted(source, i);
      if (end === undefined) {
        break;
      }
      i = end;
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
    } else if (char === ',' && depth === 0) {
      parts.push(source.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(source.slice(start).trim());
  return parts;
}

/**
 * Parses `Key (<columns>)=(<values>) conflicts with [existing ]key (<columns>)=(<values>).`
 * The column list is balanced SQL, so it's found by matching parentheses. Values aren't, so they're
 * found by locating the separator, which repeats the column list and must occur exactly once.
 */
function parseKey(detail: string): ExclusionKey | undefined {
  if (!detail.startsWith(KEY_PREFIX) || !detail.endsWith(DETAIL_END)) {
    return undefined;
  }
  const columnsEnd = closingParen(detail, KEY_PREFIX.length - 1);
  if (columnsEnd === undefined || !detail.startsWith('=(', columnsEnd + 1)) {
    return undefined;
  }
  const columnsText = detail.slice(KEY_PREFIX.length, columnsEnd);
  const attemptedStart = columnsEnd + 3;

  for (const wording of [') conflicts with existing key (', ') conflicts with key (']) {
    const separator = `${wording}${columnsText})=(`;
    const at = detail.indexOf(separator, attemptedStart);
    if (at === -1) {
      continue;
    }
    const existingStart = at + separator.length;
    const existingEnd = detail.length - DETAIL_END.length;
    if (detail.includes(separator, at + 1) || existingEnd < existingStart) {
      return undefined;
    }
    return {
      columns: splitElements(columnsText),
      attempted: detail.slice(attemptedStart, at),
      existing: detail.slice(existingStart, existingEnd),
    };
  }
  return undefined;
}

function kindOf(message: string | undefined, detail: string | undefined): ExclusionViolation['kind'] {
  if (message !== undefined) {
    return message.startsWith('could not create exclusion constraint') ? 'existing-rows' : 'conflict';
  }
  return detail === 'Key conflicts exist.' || (detail?.includes(') conflicts with key (') ?? false)
    ? 'existing-rows'
    : 'conflict';
}

/**
 * Reads an exclusion-constraint violation (SQLSTATE `23P01`) from a driver error, without string
 * matching in your own code. Works with `pg` and postgres.js errors, including when Drizzle wraps
 * them in `DrizzleQueryError`. Returns `undefined` for anything else, including deadlocks
 * (`40P01`, D16), and never throws.
 *
 * @example
 * ```ts
 * import { parseExclusionViolation } from 'drizzle-exclude';
 *
 * try {
 *   await db.insert(bookings).values({ roomId, startsAt, endsAt });
 * } catch (error) {
 *   const violation = parseExclusionViolation(error);
 *   if (violation === undefined) throw error;
 *   console.log(violation.constraint); // 'bookings_room_id_starts_at_ends_at_excl'
 *   console.log(violation.conflictingKey?.existing); // the booking already holding the slot
 * }
 * ```
 */
export function parseExclusionViolation(error: unknown): ExclusionViolation | undefined {
  const fields = errorWithCode(error, EXCLUSION_VIOLATION);
  if (fields === undefined) {
    return undefined;
  }

  const message = text(fields.message);
  const detail = text(fields.detail);
  return {
    kind: kindOf(message, detail),
    constraint:
      text(fields.constraint) ??
      text(fields.constraint_name) ??
      (message === undefined ? undefined : /exclusion constraint "(.*)"$/s.exec(message)?.[1]),
    table: text(fields.table) ?? text(fields.table_name),
    schema: text(fields.schema) ?? text(fields.schema_name),
    conflictingKey: detail === undefined ? undefined : parseKey(detail),
    detail,
  };
}
