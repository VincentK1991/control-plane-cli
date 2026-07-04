ALTER TABLE "usage_events" DROP CONSTRAINT IF EXISTS "usage_events_units_check";--> statement-breakpoint
ALTER TABLE "usage_events" ALTER COLUMN "endpoint" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_events" ALTER COLUMN "units" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN IF NOT EXISTS "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN IF NOT EXISTS "request_id" text;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN IF NOT EXISTS "job_id" text;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN IF NOT EXISTS "source" text;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN IF NOT EXISTS "event_type" text;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN IF NOT EXISTS "billable_metric" text;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN IF NOT EXISTS "quantity" integer;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN IF NOT EXISTS "unit" text;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN IF NOT EXISTS "unit_price_cents" integer;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN IF NOT EXISTS "currency" text DEFAULT 'USD';--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN IF NOT EXISTS "provider" text;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN IF NOT EXISTS "model" text;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN IF NOT EXISTS "metadata" jsonb DEFAULT '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN IF NOT EXISTS "recorded_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
UPDATE "usage_events"
SET
  "idempotency_key" = coalesce("idempotency_key", 'legacy:' || "id"::text),
  "source" = coalesce("source", "endpoint", 'legacy'),
  "event_type" = coalesce("event_type", 'legacy.usage.recorded'),
  "billable_metric" = coalesce("billable_metric", 'units'),
  "quantity" = coalesce("quantity", "units", 0),
  "unit" = coalesce("unit", 'unit'),
  "currency" = coalesce("currency", 'USD'),
  "metadata" = coalesce("metadata", '{}'::jsonb),
  "recorded_at" = coalesce("recorded_at", now());--> statement-breakpoint
ALTER TABLE "usage_events" ALTER COLUMN "idempotency_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_events" ALTER COLUMN "source" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_events" ALTER COLUMN "event_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_events" ALTER COLUMN "billable_metric" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_events" ALTER COLUMN "quantity" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_events" ALTER COLUMN "unit" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_events" ALTER COLUMN "currency" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_events" ALTER COLUMN "metadata" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_events" ALTER COLUMN "recorded_at" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "usage_events_idempotency_key_idx" ON "usage_events" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_events_api_key_time_idx" ON "usage_events" USING btree ("api_key_id","occurred_at");--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_quantity_check" CHECK ("usage_events"."quantity" >= 0);
