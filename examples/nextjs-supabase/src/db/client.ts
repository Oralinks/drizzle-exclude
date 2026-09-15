import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

// One client per server process, surviving hot reloads in development.
const cache = globalThis as typeof globalThis & { bookingDemoDb?: PostgresJsDatabase };

export function getDb(): PostgresJsDatabase {
  if (cache.bookingDemoDb) {
    return cache.bookingDemoDb;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  }
  // Supabase's transaction pooler (port 6543) doesn't support prepared statements.
  const client = postgres(url, { prepare: false });
  cache.bookingDemoDb = drizzle({ client, casing: 'snake_case' });
  return cache.bookingDemoDb;
}
