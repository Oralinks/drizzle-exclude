# CLAUDE.md — drizzle-exclude

## What this is

A small, focused npm package that adds PostgreSQL `EXCLUDE` constraint support to Drizzle ORM, plus runtime handling for the constraint violations it produces.

Drizzle has no `exclude()` in its schema API. Three open issues ask for it (#2813, #3388, #4939) and are still unresolved. Developers work around it by hand-editing generated migrations, which breaks the schema file as a source of truth. This package fills that gap and adds the part nobody has built: turning SQLSTATE `23P01` into a typed result instead of a parsed error string.

Primary use case: preventing overlapping bookings at the database level, which is the only race-safe way to do it.

## Read before writing code

1. `SCOPE.md` — what is in and out of scope. Do not add anything not listed there.
2. `DECISIONS.md` — locked technical decisions. Do not re-litigate these. If one looks wrong, raise it, don't silently change it.
3. **drizzle-orm's `check()` implementation** — in `drizzle-orm/src/pg-core/` and the corresponding drizzle-kit serializer. `check()` is a shipped, table-level constraint that drizzle-kit already emits. `exclude()` should follow that exact pattern. Read it before designing the API. Do not invent a new shape.
4. PostgreSQL docs on range types and exclusion constraints.

## Stack

- TypeScript 6.0.x, strict mode. No `any` in the public API. Not 7 yet: typescript-eslint doesn't support it (D14).
- Node 22 and 24 (D13)
- pnpm
- `tsdown` for the build — dual CJS/ESM, proper `exports` map, emitted `.d.ts`. tsup is unmaintained (D12).
- Vitest for tests
- Changesets for versioning
- GitHub Actions for CI and publishing

`drizzle-orm` is a **peer dependency**, not a dependency. Postgres drivers (`pg`, `postgres`) are optional peers.

## Testing policy

This is the most important section in this file.

**Tests run against a real PostgreSQL instance. Never a mock.** The entire claim of this package is behaviour the database enforces. A mocked database proves nothing.

**Docker + Testcontainers for every database test** (D10). Docker Desktop must be running locally; CI uses GitHub's Ubuntu runners.

PGlite was evaluated in T1.1 and not adopted. It supports `btree_gist`, but it runs a single session, so it can't reproduce races between concurrent transactions. Don't reintroduce it without raising it first.

Write the concurrency test **first**, before any implementation:
- Fire N parallel inserts for the same room and overlapping time range
- Assert exactly one succeeds and N-1 fail with `23P01` or `40P01`. Under concurrency, Postgres can reject a loser as a deadlock instead of an exclusion violation (D16).
- Also write the negative control: the same scenario using check-then-insert in application code, demonstrating that it double-books

The negative control, reproducing the race against real Postgres, is the package's entire argument and the README's opening (D17).

## Scope guardrails

Do **not** build, even if it seems helpful:

- A booking application, admin UI, or any React components
- Slot generation or availability computation (`rrule` already does this)
- Prisma or Kysely adapters
- Anything payment-related
- A CLI

Demo applications belong in `examples/`, never in `src/`.

## Repo layout

```
src/
  schema/      # exclude() builder, range helpers, btree_gist helper
  runtime/     # 23P01 parsing, typed results, reserve()
  testing/     # expectNoOverlap(), concurrency harness
  index.ts
tests/
examples/      # runnable Next.js + Supabase demo — kept out of the build
.github/workflows/
SCOPE.md
DECISIONS.md
TASKS.md
```

Three entry points in the `exports` map: `.`, `./testing`, and optionally `./runtime`. Testing helpers must not ship in the main bundle.

## Conventions

- Named exports only. No default export.
- Runtime failures return discriminated unions, they don't throw. Programmer errors (bad config, missing extension) throw immediately with an actionable message.
- Every exported symbol gets JSDoc with a runnable example.
- Conventional commits. Every user-facing change gets a changeset.
- SQL generation is verified with snapshot tests against hand-written SQL taken from the PostgreSQL docs, not against our own output.

## Commands

```
pnpm test           # unit + integration
pnpm test:db        # integration only, needs Postgres
pnpm build
pnpm typecheck
pnpm lint
pnpm changeset
```

`pnpm` must be on PATH, not only reachable through `corepack pnpm`: `pnpm build` shells out to `pnpm pack` for its publint and attw checks. Run `corepack enable` once.

## Working style

- Work through `TASKS.md` in order. Each task has acceptance criteria — meet them before moving on.
- Small commits, one concern each.
- When a decision isn't covered by `DECISIONS.md`, ask rather than guessing. Add the answer to `DECISIONS.md`.
- If you find yourself writing a workaround for something Drizzle does, stop and check whether Drizzle exposes it properly first. This package should extend Drizzle's patterns, not fight them.
