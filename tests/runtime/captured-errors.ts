// Real errors captured on 2026-09-15 from postgres:18.6-alpine through pg 8.23 (session TimeZone UTC
// unless noted). Only the fields PostgreSQL sends are kept. violation.db.test.ts reproduces each live.

export const conflictingInsert = {
  code: '23P01',
  message: 'conflicting key value violates exclusion constraint "bookings_room_id_starts_at_ends_at_excl"',
  detail: `Key (room_id, tstzrange(starts_at, ends_at, '[)'::text))=(11111111-1111-1111-1111-111111111111, ["2026-03-01 10:30:00+00","2026-03-01 11:30:00+00")) conflicts with existing key (room_id, tstzrange(starts_at, ends_at, '[)'::text))=(11111111-1111-1111-1111-111111111111, ["2026-03-01 10:00:00+00","2026-03-01 11:00:00+00")).`,
  constraint: 'bookings_room_id_starts_at_ends_at_excl',
  table: 'bookings',
  schema: 'app',
};

/** The same conflict with `SET TimeZone = 'Asia/Kolkata'`. */
export const conflictingInsertKolkata = {
  ...conflictingInsert,
  detail: `Key (room_id, tstzrange(starts_at, ends_at, '[)'::text))=(11111111-1111-1111-1111-111111111111, ["2026-03-01 16:00:00+05:30","2026-03-01 17:00:00+05:30")) conflicts with existing key (room_id, tstzrange(starts_at, ends_at, '[)'::text))=(11111111-1111-1111-1111-111111111111, ["2026-03-01 15:30:00+05:30","2026-03-01 16:30:00+05:30")).`,
};

/** A text value containing a comma, a parenthesis and both kinds of quote, printed raw. */
export const awkwardText = {
  code: '23P01',
  message: 'conflicting key value violates exclusion constraint "notes_label_during_excl"',
  detail: `Key (label, during)=(a, b) "c"='d', ["2026-01-01 10:30:00","2026-01-01 11:30:00")) conflicts with existing key (label, during)=(a, b) "c"='d', ["2026-01-01 10:00:00","2026-01-01 11:00:00")).`,
  constraint: 'notes_label_during_excl',
  table: 'notes',
  schema: 'public',
};

export const expressionElement = {
  code: '23P01',
  message: 'conflicting key value violates exclusion constraint "lowered_name_excl"',
  detail: 'Key (lower(name))=(alice) conflicts with existing key (lower(name))=(alice).',
  constraint: 'lowered_name_excl',
  table: 'lowered',
  schema: 'public',
};

/** Inserting as a role with INSERT but no SELECT on the table: PostgreSQL leaves the key out. */
export const keyWithheld = {
  code: '23P01',
  message: 'conflicting key value violates exclusion constraint "bookings_room_id_starts_at_ends_at_excl"',
  detail: 'Key conflicts with existing key.',
  constraint: 'bookings_room_id_starts_at_ends_at_excl',
  table: 'bookings',
  schema: 'app',
};

/** Two overlapping rows in one transaction against a DEFERRABLE INITIALLY DEFERRED constraint, raised at COMMIT. */
export const deferredAtCommit = {
  code: '23P01',
  message: 'conflicting key value violates exclusion constraint "deferred_bookings_room_during_excl"',
  detail: 'Key (room, during)=(1, [5,15)) conflicts with existing key (room, during)=(1, [1,10)).',
  constraint: 'deferred_bookings_room_during_excl',
  table: 'deferred_bookings',
  schema: 'public',
};

/** ALTER TABLE … ADD CONSTRAINT over rows that already overlap. */
export const addedOverExistingRows = {
  code: '23P01',
  message: 'could not create exclusion constraint "late_room_during_excl"',
  detail: 'Key (room, during)=(1, [1,10)) conflicts with key (room, during)=(1, [5,15)).',
  constraint: 'late_room_during_excl',
  table: 'late',
  schema: 'public',
};
