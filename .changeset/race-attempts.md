---
'drizzle-exclude': minor
---

Add `raceAttempts()` in `drizzle-exclude/testing`, a harness for testing code under concurrency. It runs the same attempt many times at once and collects every outcome without rejecting. Each attempt gets a `checkpoint()` that holds it until all attempts have caught up, so you can reliably reproduce the moment where every request has checked availability and none has written yet.
