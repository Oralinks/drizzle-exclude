import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/**/*.test.ts'],
          exclude: ['tests/**/*.db.test.ts'],
        },
      },
      {
        // Real PostgreSQL via Testcontainers (D10). Needs Docker running.
        extends: true,
        test: {
          name: 'db',
          include: ['tests/**/*.db.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 300_000,
        },
      },
    ],
  },
});
