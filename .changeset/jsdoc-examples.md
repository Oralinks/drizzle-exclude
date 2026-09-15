---
'drizzle-exclude': patch
---

Fix four JSDoc examples that wouldn't compile: `catchOverlap` and `ExclusionContention` returned outside a function, `needsBtreeGist` used an undefined variable, and `ExcludeElement` referred to a column that doesn't exist. Every example in the published docs is now typechecked against the real API.
