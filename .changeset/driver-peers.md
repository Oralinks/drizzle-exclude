---
'drizzle-exclude': patch
---

Declare `pg` and `postgres` as optional peer dependencies, with the same ranges as drizzle-orm. `parseExclusionViolation()` and `catchOverlap()` are now tested with both drivers and give identical results.
