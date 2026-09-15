# drizzle-exclude

**Stop double-bookings at the database, with Drizzle ORM and PostgreSQL.** Declare exclusion constraints in your Drizzle schema, get a typed result when one refuses a write, and test that it holds under concurrency.

## Your booking code has a race condition

Most booking code checks whether a slot is free, then inserts:

```ts
const clash = await db.select({ id: bookings.id }).from(bookings).where(
  and(eq(bookings.roomId, roomId), lt(bookings.startsAt, endsAt), gt(bookings.endsAt, startsAt)),
);
if (clash.length === 0) {
  await db.insert(bookings).values({ roomId, startsAt, endsAt });
}
```

When two requests arrive at the same moment, both run the check, both see a free slot, and both insert. Tests that send one request at a time never see it.

This package's test suite sends 10 of those requests for the same room and time at once, against real PostgreSQL. This is the output from its CI run:

```
unguarded: { winners: 10, failureCodes: [], rowsWritten: 10 }
```

**Ten bookings for one room.** A check in application code can't prevent this, because the slot can be taken between the check and the insert.

The fix is to let the database refuse the second booking. PostgreSQL does that with an **exclusion constraint**: a rule that no two rows may overlap, for example "same room, overlapping times". It's checked inside the database as each row is written, so it can't be raced. The same 10 requests against a table with one:

```
guarded: { winners: 1, failureCodes: [ '23P01', '23P01', '23P01', '23P01', '23P01', '23P01', '23P01', '23P01', '23P01' ], rowsWritten: 1 }
```

**One booking; the other nine are refused** with SQLSTATE `23P01`.

Drizzle can't declare exclusion constraints ([#2813](https://github.com/drizzle-team/drizzle-orm/issues/2813), [#3388](https://github.com/drizzle-team/drizzle-orm/issues/3388), [#4939](https://github.com/drizzle-team/drizzle-orm/issues/4939)). People end up hand-editing migrations, and their schema file stops describing their table. `drizzle-exclude` fills that gap and handles what happens next: turning the refusal into a typed result, and testing it.

## Install

> **Pre-release.** `drizzle-exclude` isn't on npm yet; the first release is `0.1.0`.

```bash
npm install drizzle-exclude drizzle-orm
```

Works with `pg` or `postgres` (postgres.js), through Drizzle. Tested with drizzle-orm 0.45.2 on PostgreSQL 18.

## Quick start

### 1. Define the constraint next to your table

```ts
// src/db/schema.ts
import { sql } from 'drizzle-orm';
import { boolean, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { exclude, tstzRange } from 'drizzle-exclude';

export const bookings = pgTable('bookings', {
  id: uuid().defaultRandom().primaryKey(),
  roomId: uuid().notNull(),
  startsAt: timestamp({ withTimezone: true }).notNull(),
  endsAt: timestamp({ withTimezone: true }).notNull(),
  cancelled: boolean().notNull().default(false),
});

export const bookingsNoOverlap = exclude(bookings, {
  using: 'gist',
  with: [
    [bookings.roomId, '='],                                 // same room
    [tstzRange(bookings.startsAt, bookings.endsAt), '&&'],  // overlapping times
  ],
  where: sql`not ${bookings.cancelled}`,                    // cancelled bookings don't block the slot
});
```

`tstzRange` uses half-open bounds, `[)`, so a booking ending at 11:00 and one starting at 11:00 don't clash.

### 2. Add it to a migration

drizzle-kit can't generate exclusion constraints, so create an empty custom migration:

```bash
npx drizzle-kit generate --custom --name=bookings_no_overlap
```

Then fill it with the SQL this prints:

```ts
import { exclusionMigrationSql } from 'drizzle-exclude';
import { bookingsNoOverlap } from './src/db/schema';

console.log(exclusionMigrationSql([bookingsNoOverlap], { casing: 'snake_case' }));
```

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_room_id_starts_at_ends_at_excl" EXCLUDE USING gist ("room_id" WITH =, (tstzrange("starts_at", "ends_at", '[)')) WITH &&) WHERE (not "cancelled");
```

Pass the same `casing` you give `drizzle()` and drizzle-kit. `btree_gist` is what lets PostgreSQL compare `room_id` with `=` inside this kind of index, and it's added only when a constraint needs it.

### 3. Handle the refusal as a result, not an exception

```ts
import { catchOverlap } from 'drizzle-exclude';

const result = await catchOverlap(
  db.insert(bookings).values({ roomId, startsAt, endsAt }).returning(),
);

if (!result.ok) {
  switch (result.reason) {
    case 'overlap':    // the slot is taken
      return { status: 409, body: 'That room is already booked for this time' };
    case 'contention': // simultaneous bookings deadlocked; nothing was saved
      return { status: 503, body: 'Busy, please try again' };
  }
}
return { status: 201, body: result.value[0] };
```

Any other error is rethrown unchanged.

### 4. Test it under concurrency

```ts
import { catchOverlap } from 'drizzle-exclude';
import { expectNoOverlap, raceAttempts } from 'drizzle-exclude/testing';

test('ten guests booking the same room at once get one booking', async () => {
  const { values } = await raceAttempts(() =>
    catchOverlap(db.insert(bookings).values({ roomId, startsAt, endsAt })),
  );

  expect(values.filter((result) => result.ok)).toHaveLength(1);
  await expectNoOverlap(db, bookingsNoOverlap, { casing: 'snake_case' });
});
```

## API

### `drizzle-exclude`

| Export | What it does |
|---|---|
| `exclude(table, { name?, using, with, where?, deferrable? })` | Defines an exclusion constraint. Checks its configuration straight away: columns from another table, an index method that can't back the constraint, or a name PostgreSQL would truncate all throw with a fix. |
| `tstzRange(lower, upper, { bounds? })` | A `tstzrange` over two timestamp-with-time-zone columns. A timestamp without a time zone throws. |
| `dateRange(lower, upper, { bounds? })` | A `daterange` over two `date` columns. |
| `int4Range(lower, upper, { bounds? })` | An `int4range` over two `integer` or `serial` columns. |
| `exclusionMigrationSql(constraints, { casing?, btreeGist? })` | The whole custom migration. `btreeGist: 'require'` checks for the extension instead of creating it, for hosts like Supabase where you enable it from the dashboard. |
| `exclusionConstraintSql(constraint, { casing? })` | Just the `ALTER TABLE … ADD CONSTRAINT` statement. |
| `needsBtreeGist(constraint)` / `btreeGistSql()` | Whether a constraint needs `btree_gist`, and the statement that installs it. |
| `catchOverlap(write)` | Runs a write and returns `{ ok: true, value }`, `{ ok: false, reason: 'overlap', constraint, conflictingKey }` or `{ ok: false, reason: 'contention' }`. |
| `withDeferredConstraints(db, constraints, work, { casing? })` | Runs `work` in a transaction with the constraints deferred to `COMMIT`, so bookings can swap slots through overlapping states. Returns the same result as `catchOverlap`. The constraints must be declared with `deferrable`. |
| `parseExclusionViolation(error)` | Reads a `23P01` error from `pg` or postgres.js, even when Drizzle has wrapped it: the constraint, table, schema and conflicting key. Returns `undefined` for anything else. |

### `drizzle-exclude/testing`

| Export | What it does |
|---|---|
| `raceAttempts(attempt, { attempts? })` | Runs the same attempt many times at once and collects every outcome. Each attempt gets a `checkpoint()` that holds it until all have caught up, to reproduce "everyone checked, nobody has written yet" on purpose. |
| `expectNoOverlap(db, constraint, { casing?, limit? })` | Fails, listing the clashing rows, if any two rows would break the constraint. The constraint doesn't need to exist in the database yet. |

## Good to know

- **Deadlocks instead of `23P01`.** When conflicting writes land at the same instant, PostgreSQL sometimes resolves them as a deadlock (`40P01`). That doesn't mean the slot is taken, so `catchOverlap` reports it as `'contention'`. It doesn't retry for you: in measurements, retries rarely cleared the deadlock and added seconds of latency.
- **Time zones.** Use `timestamp({ withTimezone: true })`. A booking stored without a time zone is ambiguous across zones and daylight-saving changes, so `tstzRange` refuses those columns.
- **Constraint names.** Without a `name`, a constraint is called `{table}_{columns}_excl`, which for plain columns matches PostgreSQL's own default.
- **Why a separate export instead of `pgTable`'s third argument?** Drizzle only accepts its own builders there, and drizzle-kit only generates its own constraint types. Until Drizzle supports exclusion constraints natively, the migration step above is how they get applied.

## How this is tested

Every behaviour is tested against real PostgreSQL in Docker, never a mock. That covers the race above, every generated SQL statement (each one is run and must reject an overlap), both drivers, deferred constraints and the testing helpers. [`DECISIONS.md`](DECISIONS.md) records each design choice with the measurements behind it.

## Examples

- [`examples/nextjs-supabase`](examples/nextjs-supabase): a Next.js app that books rooms on Supabase or any PostgreSQL, with a button that sends ten bookings for the same slot at once.
- [`examples/testing-harness`](examples/testing-harness): an outside project that tests its own table with `drizzle-exclude/testing`.

## License

MIT
