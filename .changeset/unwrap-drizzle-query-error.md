---
'drizzle-exclude': patch
---

`parseExclusionViolation()` now finds the violation when Drizzle has wrapped the driver error in `DrizzleQueryError`, which drizzle-orm does for every failing query. Before, it returned `undefined` for errors thrown through a Drizzle query.
