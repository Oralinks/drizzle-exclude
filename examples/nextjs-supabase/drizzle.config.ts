import { defineConfig } from 'drizzle-kit';

try {
  process.loadEnvFile();
} catch {
  // No .env file: the variables may already be set in the environment.
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  // Must match the casing passed to drizzle() and to exclusionMigrationSql().
  casing: 'snake_case',
  dbCredentials: {
    // Migrations need a direct or session-mode connection, not the transaction pooler.
    url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL ?? '',
  },
});
