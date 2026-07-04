CREATE TABLE "billing_meter_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"usage_event_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_event_identifier" text NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_customer_id" text NOT NULL,
	"provider_subscription_id" text,
	"status" text NOT NULL,
	"price_id" text,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancel_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "billing_meter_events" ADD CONSTRAINT "billing_meter_events_usage_event_id_usage_events_id_fk" FOREIGN KEY ("usage_event_id") REFERENCES "public"."usage_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_meter_events" ADD CONSTRAINT "billing_meter_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_meter_events_usage_event_idx" ON "billing_meter_events" USING btree ("usage_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_meter_events_provider_identifier_idx" ON "billing_meter_events" USING btree ("provider","provider_event_identifier");--> statement-breakpoint
CREATE INDEX "billing_meter_events_user_status_idx" ON "billing_meter_events" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "billing_subscriptions_user_id_idx" ON "billing_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_subscriptions_provider_subscription_idx" ON "billing_subscriptions" USING btree ("provider","provider_subscription_id");