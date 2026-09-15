# Example: testing your own table with `drizzle-exclude/testing`

A standalone project, not part of the package's build or workspace. It installs `drizzle-exclude` from a packed tarball and imports it only by package name, the way an npm user would. Its table is a coworking space's hot-desk reservations, to show the helpers aren't tied to the package's own booking tests.

The test file shows two things:

1. With only an application-level check, `raceAttempts()` lines up eight reservations so all of them check before any inserts. Several reserve the same desk, and `expectNoOverlap()` reports the clash.
2. With the exclusion constraint applied through `exclusionMigrationSql()`, exactly one of eight simultaneous reservations wins, and `expectNoOverlap()` passes.

## Run it

You need Docker running and `pnpm` on your PATH.

```bash
pnpm pack-local   # builds drizzle-exclude and packs it here as drizzle-exclude-0.0.0.tgz
pnpm install
pnpm test
```

After changing the package, run `pnpm pack-local` again, then `pnpm install --force` to pick up the new tarball.
