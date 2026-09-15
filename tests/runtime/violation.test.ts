import { describe, expect, it } from 'vitest';
import { parseExclusionViolation } from '../../src/index.js';
import {
  addedOverExistingRows,
  awkwardText,
  conflictingInsert,
  conflictingInsertKolkata,
  deferredAtCommit,
  expressionElement,
  keyWithheld,
} from './captured-errors.js';

const ROOM = '11111111-1111-1111-1111-111111111111';

/** postgres.js names the same fields in snake_case. */
function asPostgresJs(error: typeof conflictingInsert) {
  const { constraint, table, schema, ...rest } = error;
  return { ...rest, constraint_name: constraint, table_name: table, schema_name: schema };
}

describe('parseExclusionViolation() with captured PostgreSQL errors', () => {
  it('reads a conflicting insert', () => {
    expect(parseExclusionViolation(conflictingInsert)).toEqual({
      kind: 'conflict',
      constraint: 'bookings_room_id_starts_at_ends_at_excl',
      table: 'bookings',
      schema: 'app',
      conflictingKey: {
        columns: ['room_id', "tstzrange(starts_at, ends_at, '[)'::text)"],
        attempted: `${ROOM}, ["2026-03-01 10:30:00+00","2026-03-01 11:30:00+00")`,
        existing: `${ROOM}, ["2026-03-01 10:00:00+00","2026-03-01 11:00:00+00")`,
      },
      detail: conflictingInsert.detail,
    });
  });

  it("keeps values in the session's time zone", () => {
    expect(parseExclusionViolation(conflictingInsertKolkata)?.conflictingKey?.existing).toBe(
      `${ROOM}, ["2026-03-01 15:30:00+05:30","2026-03-01 16:30:00+05:30")`,
    );
  });

  it('keeps raw values whole when they contain commas, parentheses and quotes', () => {
    expect(parseExclusionViolation(awkwardText)?.conflictingKey).toEqual({
      columns: ['label', 'during'],
      attempted: `a, b) "c"='d', ["2026-01-01 10:30:00","2026-01-01 11:30:00")`,
      existing: `a, b) "c"='d', ["2026-01-01 10:00:00","2026-01-01 11:00:00")`,
    });
  });

  it('reads expression elements', () => {
    expect(parseExclusionViolation(expressionElement)?.conflictingKey).toEqual({
      columns: ['lower(name)'],
      attempted: 'alice',
      existing: 'alice',
    });
  });

  it('reads a deferred violation raised at COMMIT', () => {
    expect(parseExclusionViolation(deferredAtCommit)).toMatchObject({
      kind: 'conflict',
      constraint: 'deferred_bookings_room_during_excl',
      conflictingKey: { columns: ['room', 'during'], attempted: '1, [5,15)', existing: '1, [1,10)' },
    });
  });

  it('reports existing-rows when adding the constraint failed', () => {
    expect(parseExclusionViolation(addedOverExistingRows)).toMatchObject({
      kind: 'existing-rows',
      constraint: 'late_room_during_excl',
      conflictingKey: { columns: ['room', 'during'], attempted: '1, [1,10)', existing: '1, [5,15)' },
    });
  });

  it('reads postgres.js field names the same way', () => {
    expect(parseExclusionViolation(asPostgresJs(conflictingInsert))).toEqual(parseExclusionViolation(conflictingInsert));
  });
});

describe('parseExclusionViolation() when DETAIL is missing or malformed', () => {
  it('still reports the constraint when PostgreSQL withholds the key', () => {
    expect(parseExclusionViolation(keyWithheld)).toEqual({
      kind: 'conflict',
      constraint: 'bookings_room_id_starts_at_ends_at_excl',
      table: 'bookings',
      schema: 'app',
      conflictingKey: undefined,
      detail: 'Key conflicts with existing key.',
    });
  });

  it.each([
    ['no DETAIL', undefined],
    ['truncated', 'Key (room_id=('],
    ['unbalanced column list', 'Key (room_id, lower(name)=(1, x) conflicts with existing key (room_id)=(1, x).'],
    ['missing final period', 'Key (room)=(1) conflicts with existing key (room)=(2)'],
    ['unknown wording', 'Key (room)=(1) clashes with key (room)=(2).'],
    ['separator repeated inside a value', 'Key (a)=(x) conflicts with existing key (a)=(y) conflicts with existing key (a)=(z).'],
    ['unterminated quote in the column list', `Key (lower('name)=(x) conflicts with existing key (lower('name)=(y).`],
  ])('leaves conflictingKey undefined without throwing: %s', (_, detail) => {
    const violation = parseExclusionViolation({ ...conflictingInsert, detail });

    expect(violation?.constraint).toBe('bookings_room_id_starts_at_ends_at_excl');
    expect(violation?.conflictingKey).toBeUndefined();
  });

  it('takes the constraint name from the message when the field is missing', () => {
    const withoutConstraint = { ...conflictingInsert, constraint: undefined };

    expect(parseExclusionViolation(withoutConstraint)?.constraint).toBe('bookings_room_id_starts_at_ends_at_excl');
  });

  it('infers existing-rows from DETAIL when there is no message', () => {
    const withoutMessage = { ...addedOverExistingRows, message: undefined };

    expect(parseExclusionViolation(withoutMessage)?.kind).toBe('existing-rows');
  });
});

describe('parseExclusionViolation() with other errors', () => {
  it.each([
    ['a deadlock (40P01)', { ...conflictingInsert, code: '40P01' }],
    ['a unique violation (23505)', { code: '23505', message: 'duplicate key value violates unique constraint "x"' }],
    ['a plain Error', new Error('boom')],
    ['null', null],
    ['a string', '23P01'],
  ])('returns undefined for %s', (_, error) => {
    expect(parseExclusionViolation(error)).toBeUndefined();
  });
});
