import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey(),
    googleSub: text("google_sub").notNull().unique("users_google_sub_key"),
    email: text("email").notNull(),
    name: text("name"),
    avatarUrl: text("avatar_url"),
    stripeCustomerId: text("stripe_customer_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique("sessions_token_hash_key"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("sessions_user_id_idx").on(table.userId),
    index("sessions_expires_at_idx").on(table.expiresAt),
  ],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    keyHash: text("key_hash").notNull().unique("api_keys_key_hash_key"),
    status: text("status").notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    index("api_keys_user_id_idx").on(table.userId),
    check("api_keys_status_check", sql`${table.status} in ('active', 'revoked')`),
  ],
);

export const neo4jInstances = pgTable(
  "neo4j_instances",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    apiKeyId: uuid("api_key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    status: text("status").notNull(),
    tier: text("tier").notNull(),
    namespace: text("namespace").notNull(),
    releaseName: text("release_name").notNull(),
    statefulsetName: text("statefulset_name").notNull(),
    serviceName: text("service_name").notNull(),
    secretName: text("secret_name").notNull(),
    pvcName: text("pvc_name"),
    username: text("username").notNull(),
    passwordSecretRef: text("password_secret_ref").notNull(),
    boltUrl: text("bolt_url"),
    httpUrl: text("http_url"),
    externalBoltUrl: text("external_bolt_url"),
    externalHttpUrl: text("external_http_url"),
    externalBoltPort: integer("external_bolt_port"),
    plugins: jsonb("plugins").notNull().default([]),
    storageSizeGb: integer("storage_size_gb").notNull(),
    cpuRequestMillicores: integer("cpu_request_millicores").notNull(),
    cpuLimitMillicores: integer("cpu_limit_millicores").notNull(),
    memoryRequestMb: integer("memory_request_mb").notNull(),
    memoryLimitMb: integer("memory_limit_mb").notNull(),
    backupPolicy: jsonb("backup_policy").notNull().default({}),
    lastBackupAt: timestamp("last_backup_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    index("neo4j_instances_user_id_idx").on(table.userId),
    index("neo4j_instances_api_key_id_idx").on(table.apiKeyId),
    index("neo4j_instances_status_idx").on(table.status),
    uniqueIndex("neo4j_instances_release_name_idx").on(table.releaseName),
    check(
      "neo4j_instances_status_check",
      sql`${table.status} in ('provisioning', 'ready', 'failed', 'deleting', 'deleted')`,
    ),
    check("neo4j_instances_tier_check", sql`${table.tier} in ('free')`),
  ],
);

export const pipelineJobs = pgTable(
  "pipeline_jobs",
  {
    // Equal to the Temporal workflow ID, not a generated uuid() default —
    // callers (startTrackedWorkflow in pipelines/core) choose the id so it
    // can double as the Temporal workflow ID and dedupe key.
    id: text("id").primaryKey(),
    workflowType: text("workflow_type").notNull(),
    taskQueue: text("task_queue").notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    apiKeyId: uuid("api_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
    status: text("status").notNull().default("queued"),
    currentStep: text("current_step"),
    progress: jsonb("progress").notNull().default({}),
    input: jsonb("input").notNull().default({}),
    result: jsonb("result"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("pipeline_jobs_user_id_idx").on(table.userId),
    index("pipeline_jobs_api_key_id_idx").on(table.apiKeyId),
    index("pipeline_jobs_status_idx").on(table.status),
    check(
      "pipeline_jobs_status_check",
      sql`${table.status} in ('queued', 'running', 'succeeded', 'failed')`,
    ),
  ],
);

export const documentIndexingRuns = pgTable(
  "document_indexing_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instanceId: uuid("instance_id")
      .notNull()
      .references(() => neo4jInstances.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    detail: text("detail"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("document_indexing_runs_instance_id_idx").on(table.instanceId),
    check(
      "document_indexing_runs_status_check",
      sql`${table.status} in ('succeeded', 'failed')`,
    ),
  ],
);

export const billingSubscriptions = pgTable(
  "billing_subscriptions",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerCustomerId: text("provider_customer_id").notNull(),
    providerSubscriptionId: text("provider_subscription_id"),
    status: text("status").notNull(),
    priceId: text("price_id"),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    cancelAt: timestamp("cancel_at", { withTimezone: true }),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("billing_subscriptions_user_id_idx").on(table.userId),
    uniqueIndex("billing_subscriptions_provider_subscription_idx").on(
      table.provider,
      table.providerSubscriptionId,
    ),
  ],
);

export const usageEvents = pgTable(
  "usage_events",
  {
    id: uuid("id").primaryKey(),
    idempotencyKey: text("idempotency_key").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    apiKeyId: uuid("api_key_id").references(() => apiKeys.id, {
      onDelete: "set null",
    }),
    endpoint: text("endpoint"),
    units: integer("units"),
    requestId: text("request_id"),
    jobId: text("job_id"),
    source: text("source").notNull(),
    eventType: text("event_type").notNull(),
    billableMetric: text("billable_metric").notNull(),
    quantity: integer("quantity").notNull(),
    unit: text("unit").notNull(),
    unitPriceCents: integer("unit_price_cents"),
    costCents: integer("cost_cents").notNull().default(0),
    currency: text("currency").notNull().default("USD"),
    provider: text("provider"),
    model: text("model"),
    metadata: jsonb("metadata").notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("usage_events_idempotency_key_idx").on(table.idempotencyKey),
    index("usage_events_user_time_idx").on(table.userId, table.occurredAt),
    index("usage_events_api_key_time_idx").on(table.apiKeyId, table.occurredAt),
    check("usage_events_quantity_check", sql`${table.quantity} >= 0`),
    check("usage_events_cost_cents_check", sql`${table.costCents} >= 0`),
  ],
);

export const billingMeterEvents = pgTable(
  "billing_meter_events",
  {
    id: uuid("id").primaryKey(),
    usageEventId: uuid("usage_event_id")
      .notNull()
      .references(() => usageEvents.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerEventIdentifier: text("provider_event_identifier").notNull(),
    status: text("status").notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("billing_meter_events_usage_event_idx").on(table.usageEventId),
    uniqueIndex("billing_meter_events_provider_identifier_idx").on(
      table.provider,
      table.providerEventIdentifier,
    ),
    index("billing_meter_events_user_status_idx").on(table.userId, table.status),
  ],
);
