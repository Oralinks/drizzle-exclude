// Prints the custom migration that adds the booking constraint (README, "How the migrations were made").
// btreeGist: 'require' checks for the extension instead of creating it, because on Supabase you
// enable extensions from the dashboard.
import { exclusionMigrationSql } from 'drizzle-exclude';
import { bookingsNoOverlap } from '../src/db/schema.ts';

console.log(exclusionMigrationSql([bookingsNoOverlap], { casing: 'snake_case', btreeGist: 'require' }));
