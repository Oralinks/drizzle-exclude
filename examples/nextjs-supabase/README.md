# Example: room bookings with Next.js and Supabase

A small Next.js app that books rooms through `drizzle-exclude`. PostgreSQL refuses overlapping bookings with an exclusion constraint, and the app shows the result of every attempt: booked, already taken, or busy.

It has two parts:

- **A booking form.** Its server action wraps the insert in `catchOverlap()` and turns the result into a message.
- **"Send 10 bookings at once".** Ten guests book the same hour in the same room simultaneously, over separate database connections. Exactly one gets it.

It installs `drizzle-exclude` from a packed tarball and uses only its public API, the way an npm user would.

## Run it

You need Node 22+, `pnpm` on your PATH, and a PostgreSQL database: a Supabase project, or any PostgreSQL 14+.

1. **Enable `btree_gist`.** On Supabase, go to Database > Extensions and enable `btree_gist`. On other PostgreSQL, run `create extension btree_gist;` once. The migration checks for it rather than creating it (see below).
2. **Configure the connection.** Copy `.env.example` to `.env` and fill in `DATABASE_URL`, plus `DIRECT_DATABASE_URL` for Supabase.
3. **Install and migrate:**

   ```bash
   pnpm pack-local   # builds drizzle-exclude and packs it here
   pnpm install
   pnpm db:migrate
   ```

4. **Start it:** `pnpm dev`, then open http://localhost:3000.

## How the migrations were made

`drizzle/0000_create_bookings.sql` came from `pnpm db:generate --name=create_bookings`, as usual.

drizzle-kit can't generate exclusion constraints, so `drizzle/0001_bookings_no_overlap.sql` was created empty with `pnpm db:generate --custom --name=bookings_no_overlap`, then filled with the output of `pnpm constraint-sql`. That script calls `exclusionMigrationSql()` with `btreeGist: 'require'`, so the migration stops with a clear message if `btree_gist` isn't enabled, instead of installing it into the `public` schema.

## Where to look

| File | What it shows |
|---|---|
| `src/db/schema.ts` | The `bookings` table and the `exclude()` constraint beside it |
| `src/db/client.ts` | postgres.js with `prepare: false`, which Supabase's transaction pooler needs |
| `app/actions.ts` | `catchOverlap()` in a form action and in the ten-at-once race |
| `scripts/constraint-sql.ts` | Rendering the constraint's migration |
