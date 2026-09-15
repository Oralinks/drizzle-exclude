---
'drizzle-exclude': minor
---

Add `tstzRange`, `dateRange` and `int4Range`, which build the range expressions an exclusion constraint compares. Bounds default to half-open `[)`, so back-to-back bookings don't conflict. `tstzRange` only accepts timestamp columns, and throws straight away for a timestamp without a time zone. `exclude()` accepts these ranges in `with` and checks that their columns belong to the constrained table.
