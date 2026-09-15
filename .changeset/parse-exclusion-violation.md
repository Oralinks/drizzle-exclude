---
'drizzle-exclude': minor
---

Add `parseExclusionViolation()`, which turns a PostgreSQL exclusion-constraint error (SQLSTATE `23P01`) from `pg` or postgres.js into a typed object: the constraint, table and schema, whether a write was rejected or adding the constraint failed, and the conflicting key. It returns `undefined` for any other error and never throws. When PostgreSQL withholds the key, for example for a role without `SELECT` on the table, the constraint name is still reported.
