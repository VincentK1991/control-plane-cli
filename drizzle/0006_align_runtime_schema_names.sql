DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'usage_events_user_id_fkey'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'usage_events_user_id_users_id_fk'
  ) THEN
    ALTER TABLE "usage_events" RENAME CONSTRAINT "usage_events_user_id_fkey" TO "usage_events_user_id_users_id_fk";
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'usage_events_api_key_id_fkey'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'usage_events_api_key_id_api_keys_id_fk'
  ) THEN
    ALTER TABLE "usage_events" RENAME CONSTRAINT "usage_events_api_key_id_fkey" TO "usage_events_api_key_id_api_keys_id_fk";
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sessions_user_id_fkey'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sessions_user_id_users_id_fk'
  ) THEN
    ALTER TABLE "sessions" RENAME CONSTRAINT "sessions_user_id_fkey" TO "sessions_user_id_users_id_fk";
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_user_id_fkey'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_user_id_users_id_fk'
  ) THEN
    ALTER TABLE "api_keys" RENAME CONSTRAINT "api_keys_user_id_fkey" TO "api_keys_user_id_users_id_fk";
  END IF;
END $$;
--> statement-breakpoint
DROP INDEX IF EXISTS "usage_events_api_key_time_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "usage_events_user_time_idx";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_events_api_key_time_idx" ON "usage_events" USING btree ("api_key_id","occurred_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_events_user_time_idx" ON "usage_events" USING btree ("user_id","occurred_at");
