DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_key_hash_unique'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_key_hash_key'
  ) THEN
    ALTER TABLE "api_keys" RENAME CONSTRAINT "api_keys_key_hash_unique" TO "api_keys_key_hash_key";
  ELSIF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_key_hash_key'
  ) THEN
    ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_key_hash_key" UNIQUE("key_hash");
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sessions_token_hash_unique'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sessions_token_hash_key'
  ) THEN
    ALTER TABLE "sessions" RENAME CONSTRAINT "sessions_token_hash_unique" TO "sessions_token_hash_key";
  ELSIF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sessions_token_hash_key'
  ) THEN
    ALTER TABLE "sessions" ADD CONSTRAINT "sessions_token_hash_key" UNIQUE("token_hash");
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_google_sub_unique'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_google_sub_key'
  ) THEN
    ALTER TABLE "users" RENAME CONSTRAINT "users_google_sub_unique" TO "users_google_sub_key";
  ELSIF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_google_sub_key'
  ) THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_google_sub_key" UNIQUE("google_sub");
  END IF;
END $$;
