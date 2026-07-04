CREATE TABLE IF NOT EXISTS "neo4j_instances" (
  "id" uuid PRIMARY KEY NOT NULL,
  "user_id" uuid NOT NULL,
  "api_key_id" uuid NOT NULL,
  "name" text NOT NULL,
  "status" text NOT NULL,
  "tier" text NOT NULL,
  "namespace" text NOT NULL,
  "release_name" text NOT NULL,
  "statefulset_name" text NOT NULL,
  "service_name" text NOT NULL,
  "secret_name" text NOT NULL,
  "pvc_name" text,
  "username" text NOT NULL,
  "password_secret_ref" text NOT NULL,
  "bolt_url" text,
  "http_url" text,
  "plugins" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "storage_size_gb" integer NOT NULL,
  "cpu_request_millicores" integer NOT NULL,
  "cpu_limit_millicores" integer NOT NULL,
  "memory_request_mb" integer NOT NULL,
  "memory_limit_mb" integer NOT NULL,
  "backup_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "last_backup_at" timestamp with time zone,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'neo4j_instances_user_id_users_id_fk'
  ) THEN
    ALTER TABLE "neo4j_instances"
      ADD CONSTRAINT "neo4j_instances_user_id_users_id_fk"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'neo4j_instances_api_key_id_api_keys_id_fk'
  ) THEN
    ALTER TABLE "neo4j_instances"
      ADD CONSTRAINT "neo4j_instances_api_key_id_api_keys_id_fk"
      FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE cascade;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'neo4j_instances_status_check'
  ) THEN
    ALTER TABLE "neo4j_instances"
      ADD CONSTRAINT "neo4j_instances_status_check"
      CHECK ("status" in ('provisioning', 'ready', 'failed', 'deleting', 'deleted'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'neo4j_instances_tier_check'
  ) THEN
    ALTER TABLE "neo4j_instances"
      ADD CONSTRAINT "neo4j_instances_tier_check"
      CHECK ("tier" in ('free'));
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "neo4j_instances_user_id_idx" ON "neo4j_instances" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "neo4j_instances_api_key_id_idx" ON "neo4j_instances" USING btree ("api_key_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "neo4j_instances_status_idx" ON "neo4j_instances" USING btree ("status");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "neo4j_instances_release_name_idx" ON "neo4j_instances" USING btree ("release_name");
