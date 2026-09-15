---
'drizzle-exclude': minor
---

Add `exclusionConstraintSql()`, which renders an exclusion constraint as one `ALTER TABLE … ADD CONSTRAINT … EXCLUDE …;` statement for a `drizzle-kit generate --custom` migration. Pass the same `casing` you give Drizzle. Without a `name`, the constraint is called `{table}_{columns}_excl`. `exclude()` now only accepts PostgreSQL operator syntax, because operators are written into the SQL as given.
