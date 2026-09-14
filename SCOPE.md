# Open-Source Package Scope: Postgres Exclusion Constraints for Drizzle

**Working names:** `drizzle-exclude` · `pg-no-overlap` · `@oralinks/exclude`
*(check npm availability before committing — see §9)*

---

## 1. What the research found

I scanned the obvious candidate niches first. Most are dead on arrival:

| Niche | Verdict | Why |
|---|---|---|
| Paystack SDK | **Saturated** | 8+ competing TypeScript SDKs, including an official one. Several launched in 2026 alone. |
| Unified African payment SDK | **Saturated** | `ng-pay`, `pay-kit`, React Native equivalents on npm; plus PHP, Python, Flutter versions. |
| NUBAN / bank validation | **Taken** | `ng-bank-account-validator` on npm, plus PHP, Rust, .NET, Dart versions. |
| Billing / dunning engine | **Taken** | `billing-kit` (Next.js + Postgres, Stripe + Paystack, ledger, dunning) already exists. |
| Booking / scheduling app | **Crowded** | Dozens of Cal.com clones, plus a paid commercial "Booking Kit". |
| RRULE / interval algebra | **Taken** | `rrule`, `rrule-temporal` are mature. |

The gap I found is narrower and better.

---

## 2. The gap

PostgreSQL's `EXCLUDE USING gist` constraint is the only concurrency-safe way to prevent overlapping bookings. The alternative — check for a conflict, then insert — has a time-of-check-to-time-of-use race: two simultaneous requests both see no conflict, both insert, and you have a double-booking.

**Drizzle ORM does not support exclusion constraints.** Three separate feature requests are open and unresolved:

- Issue **#2813** (Aug 2024) — "Exclusion constraints"
- Issue **#3388** (Nov 2024) — explicitly asks for it using a `roomReservations` table as the example
- Issue **#4939** (Sept 2025) — a developer describing exactly the workaround: hand-editing generated migrations, so the Drizzle schema file "now represents only partially the full extent of my table definition"

Drizzle shipped `check()` constraints in drizzle-kit 0.26. It never shipped `exclude()`.

Three things make this the right target:

1. **Documented, unmet demand** with named people asking for it.
2. **It sits exactly on your stack** — Next.js, Supabase, Postgres, Vercel. Not a stretch.
3. **You have already worked the problem through** while designing the Innosan room-timer schema. That build was scoped and set aside rather than shipped, so the framing is "came out of designing a booking schema" — not "extracted from production". The package's credibility rests on its test suite, not on the client story.

And nothing on npm handles the *runtime* half: when the constraint fires, Postgres raises SQLSTATE `23P01`, and every app re-writes the same fragile string-parsing to turn that into a useful error.

---

## 3. Scope — v0.1

Three layers. Layer 1 fills the Drizzle gap; layers 2 and 3 are what keep the package useful even if Drizzle ships native support.

### Layer 1 — Schema builder

An `exclude()` helper that fits Drizzle's existing table-definition API:

```ts
export const bookings = pgTable('bookings', {
  id: uuid().defaultRandom().primaryKey(),
  roomId: uuid().notNull(),
  startsAt: timestamp({ withTimezone: true }).notNull(),
  endsAt: timestamp({ withTimezone: true }).notNull(),
  cancelled: boolean().default(false),
}, (t) => [
  exclude('bookings_no_overlap', {
    using: 'gist',
    with: [
      [t.roomId, '='],
      [tstzRange(t.startsAt, t.endsAt), '&&'],
    ],
    where: sql`not ${t.cancelled}`,
  }),
]);
```

Includes:
- Correct SQL emission for `drizzle-kit generate`
- `btree_gist` extension helper (the constraint fails without it — a very common first-time trip-up)
- Range helpers: `tstzRange`, `dateRange`, `int4Range`, with explicit bound control
- Partial `WHERE` support, so soft-cancelled rows stop blocking the slot

### Layer 2 — Runtime conflict handling

```ts
const result = await reserve(db, bookings, {
  roomId, startsAt, endsAt,
});

if (!result.ok && result.reason === 'overlap') {
  // result.constraint, result.conflictingKey — typed, no string parsing
}
```

Includes:
- Parse SQLSTATE `23P01`, extract constraint name and the conflicting key from `DETAIL`
- Typed discriminated-union result instead of a thrown error
- Works with `pg`, `postgres.js`, and the Supabase connection string
- `deferrable` transaction helper — needed when you move a block of bookings and intermediate states legitimately overlap

### Layer 3 — Testing kit

This is the part that makes the README land:

- `expectNoOverlap()` assertion helper
- A concurrency harness that fires N simultaneous inserts and asserts exactly one wins
- A runnable demo proving the naive check-then-insert approach fails under load

### Explicitly out of scope for v0.1

- Not a booking application. No UI, no routes, no admin.
- No slot generation or availability computation — `rrule` already does that. (Candidate for v0.2 as a separate entry point.)
- No Prisma or Kysely adapters. v0.3 if there is traction.
- No payments. Deliberately.

---

## 4. Decisions to lock before writing code

Write these down in a `DECISIONS.md` in the repo. Employers notice this file.

| Decision | Recommended default | Reasoning |
|---|---|---|
| Range bounds | Half-open `[)` | A checkout at 11:00 and a check-in at 11:00 are adjacent, not overlapping. Inclusive bounds break this. |
| Timestamp type | `timestamptz` only | Refuse `timestamp` at the type level. Naive timestamps are the root of most booking bugs. |
| Constraint timing | `IMMEDIATE` by default, `DEFERRABLE` opt-in | Deferrable is needed for bulk rescheduling, wrong as a default. |
| Constraint naming | `{table}_{cols}_excl`, overridable | Predictable names make the runtime error mapping reliable. |
| Cancellation | Partial index via `WHERE` | Avoids the "cancelled booking still blocks the room" bug. |

---

## 5. Engineering standard

This is the actual portfolio signal. The package solves a real problem; the repo proves how you work.

- TypeScript strict mode, no `any` in the public API
- `tsdown` dual CJS/ESM build, proper `exports` map, shipped `.d.ts` (tsup is unmaintained; DECISIONS.md D12)
- **Vitest + a real Postgres** via Testcontainers (DECISIONS.md D10) — never a mocked database, because the whole point is database-level behaviour
- GitHub Actions: lint → typecheck → test on Node 22 and 24 (D13) → publish on tag with npm provenance
- Changesets for versioning and a generated CHANGELOG
- JSDoc with runnable examples on every exported symbol
- `CONTRIBUTING.md`, MIT licence, issue and PR templates
- README that opens with the race-condition demo, not with an install command

---

## 6. Build plan — roughly 4 weeks part-time

**Week 1 — Foundation**
Repo scaffold, CI pipeline, Postgres test harness. Write the failing concurrency test *first*: two parallel inserts, both succeed, test goes red. That red test is your README's opening.

**Week 2 — Schema layer**
`exclude()` builder, range helpers, SQL snapshot tests, `btree_gist` handling. Verify output against hand-written SQL from the Postgres docs.

**Week 3 — Runtime layer**
`23P01` parsing, typed results, driver adapters, deferrable helper. Concurrency test goes green.

**Week 4 — Docs and ship**
README, `examples/` with a runnable Next.js + Supabase demo, publish `0.1.0`.

---

## 7. Distribution

A package nobody sees is not a portfolio piece. In order:

1. **Comment on Drizzle issues #2813, #3388, #4939** with a link. Those threads have subscribers who want exactly this.
2. **Write the post**: "Your booking system has a race condition you can't see in testing." Lead with the reproducible demo. Post to dev.to and the Drizzle Discord.
3. **Open a PR to Drizzle itself.** See §9 — this is the highest-value move in the whole plan.
4. Link it from oralinks.org next to the Innosan case study, so the package and the client work reinforce each other.

---

## 8. Portfolio framing

On your site, the entry should read roughly:

> **drizzle-exclude** — Database-level double-booking prevention for Drizzle ORM and PostgreSQL. Fills a two-year-old gap in Drizzle's schema API (issues #2813, #3388, #4939). Grew out of designing the booking schema for a guest house system. TypeScript, tested against real Postgres under concurrency, CI-published with npm provenance.

Then link: npm → GitHub → the blog post → the Innosan case study.

That chain tells a complete story: real client problem → correct technical solution → generalised for others → documented publicly. That is a much stronger signal than any number of finished client sites, because it shows judgement rather than just delivery.

---

## 9. Risks

**Drizzle ships native support and obsoletes Layer 1.**
This is the main risk, and the mitigation is to lean into it: open a PR against drizzle-orm implementing `exclude()` yourself. A merged PR to a repo with that many stars is a *stronger* portfolio artifact than the package. Run both tracks — the package ships now and serves people today; the PR is the bigger prize. Layers 2 and 3 survive either way, since Drizzle would only ever handle schema definition, never runtime error mapping or concurrency testing.

**Scope creep into a booking framework.**
The `examples/` folder is where a demo app belongs. Keep it out of `src/`.

**Name collision.**
Run `npm view <name>` on every candidate before you write a line of code. Do the same for the GitHub org/repo path.

**Under-testing the thing you're selling.**
The package's entire claim is correctness under concurrency. If the test suite can't demonstrate that against a real Postgres instance, the package has no argument. Build the harness in week 1, not week 4.

---

## 10. Backup idea

If you'd rather not build on top of another project's roadmap: a **prepaid timed-access session engine** — issue, extend, pause, and expire time-limited access sessions, with grace periods and clock-skew handling. Drawn from the Innosan room-timer logic, applicable to cybercafés, gaming centres, co-working spaces, and hotspot billing. Nothing comparable exists on npm. It's more original but has less proven demand and is harder to get discovered, which is why it's the backup rather than the recommendation.
