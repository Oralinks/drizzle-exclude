---
'drizzle-exclude': minor
---

Add `catchOverlap()`, which runs a write, such as a Drizzle insert, and returns a typed result instead of throwing for the outcomes a booking flow expects: `{ ok: true, value }`, `{ ok: false, reason: 'overlap', constraint, conflictingKey }` when the slot is taken, or `{ ok: false, reason: 'contention' }` when PostgreSQL resolved a deadlock between simultaneous bookings. Any other error is rethrown unchanged. It never retries on its own.
