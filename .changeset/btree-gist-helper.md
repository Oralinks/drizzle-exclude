---
'drizzle-exclude': minor
---

Add `exclusionMigrationSql()`, which renders a whole `drizzle-kit generate --custom` migration for your exclusion constraints and handles `btree_gist` first. By default it adds `CREATE EXTENSION IF NOT EXISTS btree_gist;`. With `btreeGist: 'require'`, for hosts such as Supabase where extensions are enabled from the dashboard, it instead stops the migration with a message saying exactly what to add. Also adds `needsBtreeGist()` and `btreeGistSql()`.
