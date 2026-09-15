DO $drizzle_exclude$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist') THEN
    RAISE EXCEPTION 'drizzle-exclude: exclusion constraint "bookings_no_overlap" needs the btree_gist extension, which is not installed in this database.' USING HINT = 'Add CREATE EXTENSION IF NOT EXISTS btree_gist; at the top of this migration, or enable btree_gist for the database before running it (on Supabase: Database > Extensions).';
  END IF;
END
$drizzle_exclude$;
--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_no_overlap" EXCLUDE USING gist ("room" WITH =, (tstzrange("starts_at", "ends_at", '[)')) WITH &&);
