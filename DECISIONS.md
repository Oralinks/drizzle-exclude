# DECISIONS.md — drizzle-exclude

Locked decisions. Claude Code should not change these without raising it first. Each entry records what was decided and why, so the reasoning survives.

---

### D1 — Package name: `drizzle-exclude`

Checked against the npm registry and available. It's the term someone searches after hitting Drizzle issues #2813 / #3388 / #4939, which is where most early users will come from.

Also free if needed later: `drizzle-exclusion`, `pg-no-overlap`, `pg-exclude`, `overlap-guard`.

---

### D2 — Range bounds default to half-open `[)`

A checkout at 11:00 and a check-in at 11:00 are adjacent, not overlapping. Inclusive upper bounds `[]` make the database reject a perfectly valid back-to-back booking.

Half-open is also PostgreSQL's own default for range constructors, so this matches what the database does anyway. Bounds remain configurable, but the default is `[)` and the docs explain why.

---

### D3 — `timestamptz` only, never `timestamp`

Naive timestamps are the single largest source of booking bugs. A reservation without a timezone is ambiguous the moment anything crosses a zone boundary or a DST shift.

The range helpers accept `timestamptz` columns and reject `timestamp` at the type level. This is deliberately strict: a compile error here prevents a whole category of production bug.

Drizzle's types can't tell the two timestamp kinds apart, so D20 enforces this with types plus an immediate runtime check.

---

### D4 — Constraints are `IMMEDIATE` by default, `DEFERRABLE` opt-in

Immediate is correct for the common case: reject the conflicting insert at the moment it happens.

Deferrable is needed when moving a block of bookings, where intermediate states legitimately overlap before the operation completes. That's a real requirement but a bad default, because deferring pushes failures to commit time where they're harder to handle.

---

### D5 — Constraint naming: `{table}_{columns}_excl`, overridable

Predictable names make runtime error mapping reliable, since `23P01` errors identify themselves by constraint name. An explicit name can always be passed.

---

### D6 — Cancellation handled with a partial `WHERE` clause

Without it, a cancelled booking still occupies the slot — a bug that shows up in production and confuses everyone. The `where` option on `exclude()` supports soft-delete and cancellation columns.

---

### D7 — Runtime failures return results, they don't throw

An overlap is an expected outcome of a booking attempt, not an exceptional one. Callers get a discriminated union:

```ts
{ ok: true, row } | { ok: false, reason: 'overlap', constraint, conflictingKey }
```

Throwing is reserved for programmer errors: missing `btree_gist`, malformed configuration, unsupported column types. Those throw immediately with a message that says how to fix it.

D25 extends this shape: a `'contention'` outcome for deadlocks, and `value` instead of `row`.

---

### D8 — `btree_gist` is surfaced explicitly, never auto-installed

Exclusion constraints that mix an equality column with a range column require the `btree_gist` extension. Without it the constraint fails to create, and the error message doesn't make the cause obvious — a common first-time trip-up.

The package provides a helper that emits `CREATE EXTENSION IF NOT EXISTS btree_gist` into a migration, and a clear error if a constraint needs it and it isn't present. It never silently runs DDL against someone's database.

---

### D9 — `drizzle-orm` is a peer dependency

Users bring their own Drizzle version. Bundling it would cause duplicate-instance problems and version conflicts. Postgres drivers are optional peers for the same reason.

---

### D10 — Tests run against real PostgreSQL

Non-negotiable. The package's claim is about database-enforced behaviour under concurrency. A mocked database cannot demonstrate that, and a test suite that doesn't demonstrate it leaves the package with no argument.

PGlite preferred if it supports `btree_gist`; Docker + Testcontainers otherwise. **This needs verifying in task 1 — it is an open question.**

**T1.1 result (2026-09-14):** PGlite 0.5.8 (PostgreSQL 18.3) loads `btree_gist` 1.8 via `@electric-sql/pglite/contrib/btree_gist`. Verified in a throwaway spike (since deleted):

- An equality + `tstzrange(starts_at, ends_at, '[)')` exclusion constraint with a partial `WHERE (NOT cancelled)` creates and enforces correctly.
- Overlap is rejected with SQLSTATE `23P01`; the error carries `constraint` and a populated `DETAIL`.
- Adjacent `[)` ranges are accepted (D2), the same range in a different room is accepted, and a cancelled slot can be re-booked (D6).
- `DEFERRABLE INITIALLY IMMEDIATE` creates fine (D4).
- Without the extension, creation fails with `42704: data type uuid has no default operator class for access method "gist"`. That is the message T2.5 needs to translate.
- `DETAIL` renders timestamps in the session `TimeZone` (it showed `+01`, not UTC). T3.1 parsing must not assume UTC.

**Limitation found:** PGlite runs a single session, so it cannot run concurrent transactions. Ten parallel check-then-insert attempts double-booked 10/10 when check and insert were separate statements, but only 1/10 when each was wrapped in a transaction. PGlite runs the transactions one after another, which hides the race that real Postgres shows under `READ COMMITTED`. `pglite-socket`'s multiplexer shares the same single session and doesn't change this. Docker is not installed on the dev machine.

**Decision (2026-09-14): Docker + Testcontainers for all database tests.** That covers schema, runtime and concurrency tests. The maintainer chose this over a PGlite + real-Postgres hybrid and over PGlite-only. PGlite is not used. Local development needs Docker Desktop; CI uses the Docker engine on GitHub's Ubuntu runners.

---

### D11 — Testing helpers ship in a separate entry point

`drizzle-exclude/testing` keeps the concurrency harness and assertions out of production bundles.

---

### D12 — Build with `tsdown`, not `tsup`

Decided 2026-09-14. tsup's README now says it is no longer actively maintained and recommends tsdown, which has a migration guide from tsup. tsdown covers the same requirements: dual CJS/ESM output, an `exports` map, and emitted `.d.ts`. It is also compatible with publint and arethetypeswrong for checking the published package shape.

---

### D13 — CI tests on Node 22 and 24

Decided 2026-09-14. Node 20 reached end-of-life in April 2026, and the current toolchain no longer runs on it:

- vitest 5: `^22.12.0 || ^24.0.0`
- tsdown 0.23: `^22.18.0 || ^24.11.0`
- testcontainers 12: `>=22.22`

This sets the CI and dev matrix only. The published package's `engines` range is a separate question (see open questions).

---

### D14 — TypeScript pinned to 6.0.x

Decided 2026-09-14. TypeScript 7.0.2 is the latest release, but typescript-eslint 8.70 declares `typescript: >=4.8.4 <6.1.0`, so linting would be unsupported on 7. Pin `~6.0.3`, and revisit once typescript-eslint supports 7. tsdown and vitest already accept 7, so lint is the only thing blocking it.

---

### D15 — Publish with npm trusted publishing, no npm token

Decided 2026-09-14 (T1.3). This is npm's recommended path. No long-lived token lives in repo secrets, and publishing from GitHub-hosted runners generates provenance attestations automatically, which covers the provenance requirement.

Consequences:

- The publish step runs `npm publish`, not `pnpm publish`. Trusted publishing needs npm CLI 11.5.1 or later, and pnpm's publish docs don't cover it.
- Release builds don't restore a dependency cache (`package-manager-cache: false`), following npm's guidance on cache poisoning.
- A trusted publisher is added from the package's settings page on npmjs.com, so the package appears to need to exist first. That would make the very first publish manual. Verify this at T5.4.
- When adding the trusted publisher, allow `npm publish`. Configurations created after 2026-09-03 only allow `npm stage publish` by default.
- **npm does not generate provenance for packages published from private repositories.** The GitHub repo must be public before 0.1.0 is published.

---

### D16 — Concurrent losers fail with `23P01` or `40P01`

Decided 2026-09-15 (T1.4). When conflicting inserts reach an exclusion constraint at the same moment, each can end up waiting on another's uncommitted row. Postgres breaks that cycle by aborting the waiters with `40P01` (`deadlock_detected`) instead of `23P01` (`exclusion_violation`). Which code appears depends on timing.

Measured against `postgres:18.6-alpine`, 10 attempts per round, 3 rounds per pattern, on the guarded table:

| Pattern | Outcome |
|---|---|
| All attempts check, then all insert at once | 1 winner per round; 27 × `23P01` |
| 10 plain `INSERT`s fired together | 1 winner per round; 27 × `23P01` |
| Check-then-insert, starts staggered 0–50 ms | 1 winner per round; 7 × `23P01`, 9 × `40P01`, 11 rejected by the app's own check |

The first T1.4 run, under CPU load from a parallel typecheck, got 9 × `40P01`.

Every round wrote exactly one booking. So:

- Concurrency tests assert one winner, one row, and every loser failing with `23P01` or `40P01`. Asserting `23P01` alone would be flaky.
- A `40P01` doesn't name the constraint and carries no conflicting-key `DETAIL`, so the runtime layer can't map it straight to an overlap. How `reserve()` reports it is an open question for T3.

---

### D17 — T1.4's guarded test passes from the start

Decided 2026-09-15. TASKS.md originally wanted the guarded test red at T1.4 while also using a hand-written constraint, which makes it pass. Resolved: keep the hand-written constraint, so the test passes now. The negative control is what demonstrates the race and opens the README. T2.6 replaces the hand-written SQL with `exclude()`, and the test must stay green.

The negative control uses a barrier (every attempt checks before any attempt inserts), so it double-books deterministically: 10 of 10 every round. Without the barrier, attempts staggered by 0–50 ms still double-booked in one of three rounds (5 bookings).

---

### D18 — Layer 1 renders SQL for custom migrations; upstream PR in parallel

Decided 2026-09-15, after T2.1 (PR #1). A separate package can't make drizzle-kit emit `EXCLUDE`. `pgTable` only accepts Drizzle's own builders, `getTableConfig` drops anything else, and drizzle-kit's constraint SQL is hard-coded. This is the same in 0.45.2 and 1.0.0-beta.22.

- `exclude()` is defined in TypeScript as its own export next to its table, not inside `pgTable`'s third argument, which rejects it. The builder follows the shape of `check()` and `IndexBuilder`.
- The package renders the exact `EXCLUDE` DDL, plus `CREATE EXTENSION IF NOT EXISTS btree_gist` (D8), for a `drizzle-kit generate --custom` migration. No CLI (CLAUDE.md scope guardrails).
- No workarounds against Drizzle internals: no subclassing `CheckBuilder`, no fake index builders, no patching `getTableConfig`.
- The upstream drizzle-orm and drizzle-kit PR (T6.3) is the real fix. It runs alongside the package instead of waiting for Phase 6, most likely against Drizzle's `beta` branch.

The consequence: the schema file holds the constraint's definition, but applying it still takes a custom migration until Drizzle supports `exclude()` natively.

---

### D19 — `exclude()` takes the table and a config object

Decided 2026-09-15 (T2.2). `exclude(table, { name?, using, with, where?, deferrable? })` returns an `ExclusionConstraint`. Chosen over a chained builder (`exclude(name).on(table).using(…)`): it mirrors `pgPolicy(name, config)` and keeps everything the SQL needs in one typed object.

- `name` is optional. D5's default name is worked out when SQL is rendered (T2.4), because it needs the range helpers (T2.3) to report which columns they use.
- `using` only allows the index methods that can back an exclusion constraint: `gist`, `spgist`, `btree`, `hash`. GIN and BRIN can't.
- `with` is a non-empty list of `[column or sql expression, operator]` pairs. Columns must belong to the same table. The types check the table name; the runtime check compares the table itself, which also catches a same-named table in another schema.
- `deferrable: 'immediate' | 'deferred'` becomes `DEFERRABLE INITIALLY IMMEDIATE` or `DEFERRABLE INITIALLY DEFERRED`. Leaving it out gives a non-deferrable constraint (D4).
- Invalid configuration throws immediately with a message saying how to fix it. That includes names over PostgreSQL's 63-byte identifier limit, which PostgreSQL would silently truncate, breaking D5's error mapping.

---

### D20 — D3 is enforced by types plus an immediate runtime check

Decided 2026-09-15 (T2.3). This was the recommended option, picked without asking under the maintainer's standing instruction. Drizzle's types can't tell `timestamp()` from `timestamp({ withTimezone: true })`: in both 0.45.2 and 1.0.0-beta.22 the time zone is only a runtime flag, and the column type is identical. So the compile error D3 asks for is impossible without replacing Drizzle's column API.

- **Types:** `tstzRange` only accepts timestamp columns. Any other column type is a compile error.
- **Runtime:** a timestamp column without a time zone throws as soon as `tstzRange()` runs, which is when the schema file is imported. The message says to declare it as `timestamp({ withTimezone: true })`.
- **Rejected:** a package-specific `timestamptz()` column helper with its own branded type. It would push users off Drizzle's column API, and it would depend on the brand surviving Drizzle's type transforms.

---

### D21 — Range helpers return a `RangeExpression`

Decided 2026-09-15 (T2.3). Recommended option, picked without asking.

- `tstzRange(lower, upper, { bounds? })`, `dateRange` and `int4Range` return a `RangeExpression`. That's a Drizzle `SQLWrapper`, so it works anywhere `sql` does, and it also records its range function, columns and bounds. `exclude()` accepts it in `with` and checks its columns belong to the table, both in types and at runtime. T2.4 can use those columns for D5's default name.
- Bounds default to `[)` (D2); `[]`, `(]` and `()` are also allowed. Because bounds can only be one of those four literals, they're written into the SQL directly rather than sent as a query parameter, which DDL can't use.
- Accepted columns: `tstzRange` takes timestamps with a time zone (D20), `dateRange` takes `date` columns, and `int4Range` takes `integer` and `serial` columns. Both bounds must come from the same table.

---

### D22 — `exclusionConstraintSql()` renders one `ALTER TABLE … ADD CONSTRAINT` statement

Decided 2026-09-15 (T2.4). Recommended options, picked without asking.

- `exclusionConstraintSql(constraint, { casing? })` returns a single statement ending in `;`, for example `ALTER TABLE "bookings" ADD CONSTRAINT "…" EXCLUDE USING gist (…) WHERE (…) DEFERRABLE INITIALLY DEFERRED;`. It's an `ALTER TABLE` because drizzle-kit's own migration creates the table; this statement goes in a `drizzle-kit generate --custom` migration that runs after it.
- `casing` must match the `casing` passed to `drizzle()` and drizzle-kit. It decides the column names in the SQL and in the default name.
- Rendering uses Drizzle's own DDL mode, `PgDialect.sqlToQuery(sql, 'indexes')`, the same one drizzle-kit uses for index expressions: bare column names with casing applied. Query parameters are inlined, because DDL can't take them, without changing the caller's `sql` objects.
- Plain columns are written bare. Ranges and other expressions are wrapped in parentheses, which PostgreSQL accepts for any expression element.
- D5's default name is `{table}_{columns}_excl`, built from the database names of the columns in `with`, in order and without repeats, including columns inside ranges and `sql` expressions. `WHERE` columns don't count. With plain columns this matches PostgreSQL's own default name, for example `room_reservation_room_during_excl`. A default name over 63 bytes throws and asks for an explicit `name`.
- Operators are written into the SQL exactly as given, so `exclude()` now only accepts PostgreSQL operator syntax: a run of operator characters such as `&&`, or `OPERATOR(schema.op)`. Anything else throws.

---

### D23 — `btree_gist` is handled inside the rendered migration

Decided 2026-09-15 (T2.5). Recommended options, picked without asking.

Measured on `postgres:18.6-alpine`: without `btree_gist`, GiST supports `=` only on range and multirange types. `uuid`, `text`, `integer`, `timestamptz` and other scalars fail with `42704: data type uuid has no default operator class for access method "gist"`, which doesn't mention the extension. `btree_gist` 1.8 adds `=` for 26 scalar types, including enums, integers, numerics, `text`, `uuid`, dates, times, timestamps, `inet` and `bytea`.

- `needsBtreeGist(constraint)` is true for a `gist` constraint with any `with` element that isn't a range: a column whose type isn't a range, multirange, or one of PostgreSQL's built-in GiST types (`point`, `box`, `circle`, `polygon`, `tsvector`, `tsquery`), or any `sql` expression. An expression's type is unknown, and an unneeded `IF NOT EXISTS` is harmless.
- `btreeGistSql()` returns `CREATE EXTENSION IF NOT EXISTS btree_gist;`.
- `exclusionMigrationSql(constraints, { casing?, btreeGist? })` returns a whole custom migration, with statements separated by drizzle-kit's `--> statement-breakpoint` so drizzle-orm's migrator runs them one by one.
  - `btreeGist: 'create'` (the default) puts the extension statement first when any constraint needs it.
  - `btreeGist: 'require'` puts a `DO` block first instead. If the extension is missing, it stops the migration (SQLSTATE `P0001`) with a message naming the constraints and a hint saying to add `CREATE EXTENSION IF NOT EXISTS btree_gist;` at the top of the migration or enable the extension first. This is for hosts such as Supabase, where extensions are enabled outside migrations.
- The package never runs any of this itself (D8). It only goes into a migration the user reviews and runs.

---

### D24 — `parseExclusionViolation()` reads 23P01 errors without guessing values apart

Decided 2026-09-15 (T3.1). Recommended options, picked without asking. The design follows errors captured from PostgreSQL 18.6:

| Case | Message / `DETAIL` |
|---|---|
| Conflicting insert | `conflicting key value violates exclusion constraint "…"` / `Key (room_id, tstzrange(starts_at, ends_at, '[)'::text))=(…) conflicts with existing key (…)=(…).` |
| Deferred constraint at `COMMIT` | same as a conflicting insert |
| Adding a constraint over rows that already clash | `could not create exclusion constraint "…"` / `Key (…)=(…) conflicts with key (…)=(…).` |
| Role without `SELECT` on the table (per PostgreSQL's source, row-level security too) | `Key conflicts with existing key.` — no key at all |

Values are printed raw: a text value `a, b) "c"='d'` appears unescaped, and timestamps follow the session's `TimeZone`.

- `parseExclusionViolation(error)` returns `undefined` for anything that isn't SQLSTATE `23P01`, including `40P01` (D16), and never throws.
- It reads `pg`'s field names (`constraint`, `table`, `schema`) and postgres.js's (`constraint_name`, `table_name`, `schema_name`); T3.3 tests both drivers. If the constraint field is missing, the name comes from the message.
- **Fixed after T3.1 merged:** drizzle-orm 0.45.2 wraps every failing query in `DrizzleQueryError`, with the driver error as `cause`. The first version only looked at the top-level error, so it returned `undefined` for every error thrown through a Drizzle query. The parser now follows `cause`, up to 5 levels, to find the PostgreSQL error. A database test inserts through Drizzle's `node-postgres` driver to prove it.
- `kind` is `'conflict'` for a rejected write and `'existing-rows'` when adding the constraint failed.
- `conflictingKey` is `{ columns, attempted, existing }`, or `undefined` when `DETAIL` leaves the key out or has an unexpected shape. `columns` is split per element, respecting parentheses and quotes, because the column list is valid SQL. `attempted` and `existing` each stay one string, because raw values can contain commas, brackets and quotes, so no split would be reliable.
- It's exported from the main entry point. A separate `./runtime` entry isn't needed yet.

---

### D25 — `catchOverlap()` returns overlap or contention, and never retries

Decided 2026-09-15 (T3.2). Recommended options, picked without asking. This resolves D16's open question and extends D7's result shape.

Measured on `postgres:18.6-alpine`: 20 simultaneous conflicting inserts per round, 10 rounds per strategy, retrying `40P01` up to 4 times.

| Strategy | First-attempt `40P01` | Still `40P01` after 4 retries | Rounds where no first attempt succeeded | Average round |
|---|---|---|---|---|
| Immediate retry | 20 | 19 | 1 | 9.5 s |
| Jittered backoff (random wait up to 25 ms, doubling) | 100 | 95 | 5 | 45 s |

Deadlocks depend on timing: an earlier run of 10 attempts × 8 rounds saw none. Every round still wrote exactly one booking.

- **A `40P01` doesn't mean the slot is taken.** Sometimes every contender deadlocks and nobody has booked yet, so it can't be reported as an overlap.
- **Retrying doesn't reliably clear it.** Retried attempts keep colliding, and each deadlock costs PostgreSQL's one-second `deadlock_timeout`.

So:

- `catchOverlap(write)` takes a Drizzle query, or a function returning one. It resolves to `{ ok: true, value }`, to `{ ok: false, reason: 'overlap', constraint, conflictingKey, violation }` for a `23P01` conflict, or to `{ ok: false, reason: 'contention', error }` for `40P01`. Both errors are found through Drizzle's `DrizzleQueryError` wrapper.
- It never retries. Only the caller knows whether the unit of work is safe to repeat, and the measurements show retries mostly add latency.
- Anything else is rethrown unchanged. That includes a `23P01` from adding a constraint over clashing rows (`kind: 'existing-rows'`), which is a migration problem rather than a booking outcome.
- D7 said `row`. The success field is `value`, because a write can resolve to anything, such as the array `.returning()` gives.

---

### D26 — Both drivers go through the same code, with no adapters

Decided 2026-09-15 (T3.3). Recommended options, picked without asking.

A shared test suite runs the same checks with `pg` 8.23 and postgres.js 3.4.9, each against its own database with identical tables:

- a raw driver error
- a deferred violation at `COMMIT`
- a role without `SELECT` on the table
- `catchOverlap()` through each driver's Drizzle integration
- 10 concurrent bookings

The parsed results are identical, field for field.

- **The drivers differ only in field names.** `pg` uses `constraint`, `table` and `schema`; postgres.js uses `constraint_name`, `table_name` and `schema_name`. `parseExclusionViolation()` already reads both (D24), so no per-driver adapter code is needed.
- **Drizzle wraps errors from both drivers in `DrizzleQueryError`**, since both go through `PgPreparedQuery.queryWithCache`, and the parser unwraps it.
- **Optional peer dependencies:** `pg` and `postgres`, with drizzle-orm 0.45.2's own ranges (`>=8` and `>=3`). The package imports neither; the entries document which drivers it's tested with.

---

### D27 — `withDeferredConstraints()` defers named constraints inside a Drizzle transaction

Decided 2026-09-15 (T3.4). Recommended options, picked without asking.

Measured on `postgres:18.6-alpine`, moving three rows in a cycle (A to B's slot, B to C's, C to A's) inside one transaction:

| Constraint timing | Three separate UPDATEs | After `SET CONSTRAINTS … DEFERRED` | One UPDATE with `CASE` |
|---|---|---|---|
| Not deferrable | fails `23P01` | fails `42809`, not deferrable | fails `23P01` |
| `DEFERRABLE INITIALLY IMMEDIATE` | fails `23P01` | works | works (checked at end of statement) |
| `DEFERRABLE INITIALLY DEFERRED` | works | works | works |

A real overlap under deferral fails at `COMMIT` with `23P01`. Schema-qualified, quoted names work in `SET CONSTRAINTS`.

- `withDeferredConstraints(db, constraints, work, { casing? })` opens a Drizzle transaction, runs `SET CONSTRAINTS … DEFERRED` for the given constraints, runs `work(tx)`, and returns the same `ExclusionResult` as `catchOverlap()` (D25). An overlap found at `COMMIT` is `'overlap'`; an error from `work` is rethrown after the rollback. It never retries.
- Names come from D5/D22's naming, are schema-qualified when the table has a schema, and appear once each.
- A constraint without `deferrable` in its `exclude()` config throws immediately, before any transaction starts. PostgreSQL can't defer it, and changing deferrability means dropping and re-adding the constraint. An empty list throws too.
- It takes any Drizzle Postgres database (`PgDatabase`), so it works with both drivers (D26), and is tested with each.

---

### D28 — `expectNoOverlap()` asks PostgreSQL which row pairs would clash

Decided 2026-09-15 (T4.1). Recommended options, picked without asking.

- `expectNoOverlap(db, constraint, { casing?, limit? })` is exported from `drizzle-exclude/testing` (D11). It resolves when no two rows would break the constraint, and otherwise rejects listing up to `limit` (default 10) clashing pairs as row JSON. It rejects with a plain `Error`, so it works with any test runner.
- The constraint doesn't need to exist in the database. One query renders each `with` element and the `WHERE` exactly as `exclusionConstraintSql()` does, into a CTE, then joins that CTE to itself on `ctid` using the constraint's operators. So it handles columns, ranges and any `sql` expression without aliasing columns.
- **Checked against PostgreSQL itself.** The test data covered an overlap, back-to-back bookings, a cancelled row, another room, a NULL room and a case-insensitive name clash. The query flagged exactly the pairs PostgreSQL named when adding the real constraint failed, and found nothing once they were removed, after which the constraint was created.
- `db.execute()` resolves to `{ rows }` with node-postgres and to an array with postgres.js; both are read.
- Programmer errors, such as something that isn't a constraint or a `limit` that isn't a positive integer, throw immediately.
- The pair-finding query stays internal, because SCOPE lists only the assertion.

---

### D29 — `raceAttempts()` is the concurrency harness, checked from an outside project

Decided 2026-09-15 (T4.2). Recommended options, picked without asking.

- `raceAttempts(attempt, { attempts? })` is exported from `drizzle-exclude/testing` (D11). It starts `attempts` copies of `attempt` together (default 10) and resolves with every outcome in attempt order: `results` (settled), `values` and `errors`. It never rejects.
- Each attempt receives `checkpoint()`. Awaiting it holds that attempt until every other attempt has reached its checkpoint or finished without one, then releases them together. This is T1.4's barrier made general: it forces the worst-case interleaving deterministically, and an attempt that fails early can't leave the rest waiting.
- It's framework-agnostic and knows nothing about databases. It pairs with `catchOverlap()` and `expectNoOverlap()`.
- The package's own concurrency test uses it now, instead of its private barrier.
- **Checked from outside:** `examples/testing-harness/` is a standalone project with its own `pnpm-workspace.yaml`, outside the package's build. It installs the packed tarball, imports only `drizzle-exclude` and `drizzle-exclude/testing`, and tests a different table, hot-desk reservations. There, `raceAttempts()` shows check-then-insert double-booking and `expectNoOverlap()` catches it; with the constraint applied through `exclusionMigrationSql()`, exactly one of eight simultaneous reservations wins. It doesn't run in CI yet; T5.2 decides how examples run there.

---

## Open questions

- ~~Does PGlite support `btree_gist`?~~ Yes, resolved in T1.1 (see D10).
- ~~Where does the concurrency suite run?~~ Resolved: Docker + Testcontainers everywhere (see D10).
- ~~Layer 1 direction~~ Resolved: D18.
- Minimum supported Drizzle version. T2.1 found `check()`, `PgTableExtraConfigValue` and `getTableConfig` identical in 0.45.2 and 1.0.0-beta.22. Under D18 the package doesn't hook into drizzle-kit, so pick the earliest versions the builder compiles and tests against. T2.2 sets a provisional peer range of `^0.45.2`, the only version tested so far. Widen it once CI tests older releases or the 1.0 beta.
- Whether `reserve()` belongs in v0.1 or whether the typed error mapping alone is enough to ship.
- Published `engines` range. Dev tooling needs Node 22+ (D13), but the shipped runtime code may work on older Node. Decide once there is code to check.
- ~~How `reserve()` reports `40P01`~~ Resolved: a distinct `'contention'` result, with no automatic retry (D25).
