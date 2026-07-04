ALTER TABLE "neo4j_instances" ADD COLUMN IF NOT EXISTS "external_bolt_url" text;
--> statement-breakpoint
ALTER TABLE "neo4j_instances" ADD COLUMN IF NOT EXISTS "external_http_url" text;
--> statement-breakpoint
ALTER TABLE "neo4j_instances" ADD COLUMN IF NOT EXISTS "external_bolt_port" integer;
