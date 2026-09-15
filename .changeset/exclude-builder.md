---
'drizzle-exclude': minor
---

Add `exclude()`, a typed builder for PostgreSQL exclusion constraints on Drizzle tables. It checks its configuration up front: a column from another table, an empty `with` list, an index method that can't back the constraint, or a name PostgreSQL would truncate all throw with a message saying how to fix it. Rendering the constraint's SQL follows in a later release.
