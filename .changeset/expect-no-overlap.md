---
'drizzle-exclude': minor
---

Add `expectNoOverlap()` in `drizzle-exclude/testing`. It asserts that no two rows in a table would break an exclusion constraint, and rejects listing the clashing pairs otherwise. The constraint doesn't need to exist in the database, so it also shows what would stop the constraint being added. Works with `pg` and postgres.js, and with any test runner.
