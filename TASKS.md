# TASKS.md — drizzle-exclude

Work in order. Each task has acceptance criteria — meet them before moving on. Commit at the end of each task.

---

## Phase 1 — Foundation

### T1.1 — Resolve the test database question
**Do this before anything else.** Spike: can PGlite load the `btree_gist` extension and create an exclusion constraint mixing an equality column with a `tstzrange`?

- If yes → PGlite is the test database. Record it in `DECISIONS.md`.
- If no → Docker + Testcontainers. Record that, with the reason.

**Acceptance:** a throwaway script creates a table with a working exclusion constraint and the decision is written down. Delete the script afterwards.

**Done 2026-09-14.** PGlite loads `btree_gist` and enforces the constraint, but it can't run concurrent transactions, so Docker + Testcontainers was chosen. See D10. Spike script deleted.

### T1.2 — Repo scaffold
pnpm, TypeScript 6.0 strict (D14), tsdown dual CJS/ESM with `exports` map and `.d.ts` (D12), Vitest, ESLint, Changesets, MIT licence.

**Acceptance:** `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test` all pass on an empty project.

**Done 2026-09-14.** All four pass. tsdown writes the `exports` map and runs publint and attw during the build: attw reports no problems, and publint only notes the missing `engines.node` (an open question in DECISIONS.md). The build needs `pnpm` on PATH, because the pack step shells out to it.

### T1.3 — CI pipeline
GitHub Actions: lint → typecheck → test on Node 22 and 24 (D13). Separate publish workflow triggered on tag, using npm provenance.

**Acceptance:** CI green on the first push. Publish workflow exists but hasn't run.

**Done 2026-09-15.** First push to the private repo `Oralinks/drizzle-exclude`; CI run 34907412749 passed in 50s. `publish.yml` exists and hasn't run (publishing approach: D15).

### T1.4 — The failing concurrency test
The package's central argument. Two tests:

1. **Negative control** — check-then-insert in application code. Fire 10 parallel attempts at the same room and overlapping range. Assert that more than one succeeds. This test *passing* proves the race is real.
2. **The target** — same scenario against a table with an exclusion constraint. Assert exactly one succeeds and the rest fail with SQLSTATE `23P01`. Red for now.

Use hand-written SQL for the constraint at this stage. The builder doesn't exist yet.

**Acceptance:** test 1 green, test 2 red for the right reason. Both run against real Postgres.

---

## Phase 2 — Schema layer

### T2.1 — Study `check()`
Read drizzle-orm's `check()` implementation and its drizzle-kit serializer. Write a short note in the PR describing the pattern `exclude()` will follow.

**Acceptance:** the note exists and names the specific files and functions involved.

### T2.2 — `exclude()` builder
Table-level constraint builder taking `using`, `with` (column/expression + operator pairs), and optional `where`.

**Acceptance:** compiles, integrates with `pgTable`'s third argument, fully typed, no `any` in the signature.

### T2.3 — Range helpers
`tstzRange`, `dateRange`, `int4Range`, with bound control defaulting to `[)` per D2. `tstzRange` rejects naive `timestamp` columns at the type level per D3.

**Acceptance:** a `timestamp` column passed to `tstzRange` is a compile error, with a test asserting it (`expectTypeOf` or equivalent).

### T2.4 — SQL generation and snapshot tests
Emit correct DDL. Snapshots compare against SQL taken from the PostgreSQL documentation, not against our own output.

Cover: simple range-only exclusion; equality + range with `btree_gist`; partial `WHERE`; deferrable; custom constraint name.

**Acceptance:** every snapshot matches hand-verified SQL. Each generated statement has been run against a real database and created a working constraint.

### T2.5 — `btree_gist` helper
Emits `CREATE EXTENSION IF NOT EXISTS btree_gist`. Clear, actionable error if a constraint needs it and it's absent. Never runs DDL on its own (D8).

**Acceptance:** the error message tells the user exactly what to add and where.

### T2.6 — Concurrency test goes green
Replace the hand-written SQL in T1.4 with the builder.

**Acceptance:** test 2 green. Test 1 still passing, still demonstrating the race.

---

## Phase 3 — Runtime layer

### T3.1 — Parse `23P01`
Extract constraint name and conflicting key from the error `DETAIL`. Handle the cases where `DETAIL` is missing or in an unexpected shape without crashing.

**Acceptance:** tested against real errors captured from Postgres, including at least one malformed-detail case.

### T3.2 — Typed results
Discriminated union per D7. Overlaps return, programmer errors throw.

**Acceptance:** exhaustive `switch` on the result type compiles with no fallthrough.

### T3.3 — Driver adapters
`pg` and `postgres.js`. These surface errors differently — normalise both.

**Acceptance:** identical result shape from both drivers, proven by a shared test suite run twice.

### T3.4 — Deferrable transaction helper
For bulk reschedules where intermediate states legitimately overlap (D4).

**Acceptance:** a test moves three bookings in a cycle — A→B, B→C, C→A — which is impossible without deferral.

---

## Phase 4 — Testing kit

### T4.1 — `expectNoOverlap()`
Assertion helper for consumers' own test suites.

### T4.2 — Concurrency harness
Extract the T1.4 machinery into a reusable, documented export under `drizzle-exclude/testing` (D11).

**Acceptance:** an outside project can import it and test its own tables. Verify by using it in `examples/`.

---

## Phase 5 — Docs and ship

### T5.1 — README
Opens with the race condition, not the install command. Structure: the problem → the negative-control test output showing a double-booking → the fix → install → API reference → links to the three Drizzle issues.

**Acceptance:** a reader who has never heard of exclusion constraints understands the problem within the first screen.

### T5.2 — `examples/`
Runnable Next.js + Supabase booking demo. Minimal UI. Must use the published API surface, not internal imports.

### T5.3 — JSDoc pass
Every exported symbol, each with a runnable example.

### T5.4 — Publish 0.1.0
Changeset, tag, publish workflow with provenance.

**Acceptance:** `npm install drizzle-exclude` works in a clean project. Provenance badge shows on the npm page.

---

## Phase 6 — Distribution

Not code, but the part that makes it a portfolio piece rather than a private repo.

### T6.1 — Comment on Drizzle issues #2813, #3388, #4939
Short, useful, no marketing. Describe what it does and link it.

### T6.2 — Write the post
"Your booking system has a race condition you can't see in testing." Lead with the negative-control test output. Post to dev.to, share in the Drizzle Discord.

### T6.3 — Open a PR to drizzle-orm
Implement `exclude()` upstream, following the `check()` pattern from T2.1. Highest-value item in the whole plan — a merged PR to a repo that size outweighs the package itself.

### T6.4 — Add to oralinks.org
Link npm → GitHub → the post, next to the Innosan work.
