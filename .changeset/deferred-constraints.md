---
'drizzle-exclude': minor
---

Add `withDeferredConstraints()`, which runs work in a Drizzle transaction with your exclusion constraints deferred to `COMMIT`. That lets bookings pass through overlapping states on the way to a valid result, such as swapping slots in a cycle. It returns the same typed result as `catchOverlap()`, so a final arrangement that still clashes comes back as `'overlap'`. Constraints must be declared with `deferrable` in `exclude()`; otherwise it throws before starting the transaction.
