import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema";
import { requireEnv } from "./env";

const { Pool } = pg;

let pool: pg.Pool | undefined;
let drizzleDb: ReturnType<typeof drizzle<typeof schema>> | undefined;
let schemaReady: Promise<void> | undefined;

export function getPool() {
  pool ??= new Pool({
    connectionString: requireEnv("DATABASE_URL"),
  });

  return pool;
}

export function getDb() {
  drizzleDb ??= drizzle(getPool(), { schema });
  return drizzleDb;
}

export async function ensureSchema() {
  schemaReady ??= getPool().query(`
    create table if not exists users (
      id uuid primary key,
      google_sub text unique not null,
      email text not null,
      name text,
      avatar_url text,
      stripe_customer_id text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists sessions (
      id uuid primary key,
      user_id uuid not null references users(id) on delete cascade,
      token_hash text not null unique,
      expires_at timestamptz not null,
      created_at timestamptz not null default now()
    );

    create table if not exists api_keys (
      id uuid primary key,
      user_id uuid not null references users(id) on delete cascade,
      name text not null,
      key_prefix text not null,
      key_hash text not null unique,
      status text not null check (status in ('active', 'revoked')),
      last_used_at timestamptz,
      expires_at timestamptz,
      created_at timestamptz not null default now(),
      revoked_at timestamptz
    );

    create table if not exists neo4j_instances (
      id uuid primary key,
      user_id uuid not null references users(id) on delete cascade,
      api_key_id uuid not null references api_keys(id) on delete cascade,
      name text not null,
      status text not null check (status in ('provisioning', 'ready', 'failed', 'deleting', 'deleted')),
      tier text not null check (tier in ('free')),
      namespace text not null,
      release_name text not null,
      statefulset_name text not null,
      service_name text not null,
      secret_name text not null,
      pvc_name text,
      username text not null,
      password_secret_ref text not null,
      bolt_url text,
      http_url text,
      plugins jsonb not null default '[]'::jsonb,
      storage_size_gb integer not null,
      cpu_request_millicores integer not null,
      cpu_limit_millicores integer not null,
      memory_request_mb integer not null,
      memory_limit_mb integer not null,
      backup_policy jsonb not null default '{}'::jsonb,
      last_backup_at timestamptz,
      last_error text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      deleted_at timestamptz
    );

    create table if not exists billing_subscriptions (
      id uuid primary key,
      user_id uuid not null references users(id) on delete cascade,
      provider text not null,
      provider_customer_id text not null,
      provider_subscription_id text,
      status text not null,
      price_id text,
      current_period_start timestamptz,
      current_period_end timestamptz,
      cancel_at timestamptz,
      canceled_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists usage_events (
      id uuid primary key,
      idempotency_key text unique,
      user_id uuid not null references users(id) on delete cascade,
      api_key_id uuid references api_keys(id) on delete set null,
      endpoint text,
      units integer check (units >= 0),
      request_id text,
      job_id text,
      source text,
      event_type text,
      billable_metric text,
      quantity integer check (quantity >= 0),
      unit text,
      unit_price_cents integer,
      cost_cents integer not null default 0 check (cost_cents >= 0),
      currency text not null default 'USD',
      provider text,
      model text,
      metadata jsonb not null default '{}'::jsonb,
      occurred_at timestamptz not null default now(),
      recorded_at timestamptz not null default now()
    );

    create table if not exists billing_meter_events (
      id uuid primary key,
      usage_event_id uuid not null references usage_events(id) on delete cascade,
      user_id uuid not null references users(id) on delete cascade,
      provider text not null,
      provider_event_identifier text not null,
      status text not null,
      attempts integer not null default 0,
      last_error text,
      synced_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists pipeline_jobs (
      id text primary key,
      workflow_type text not null,
      task_queue text not null,
      user_id uuid references users(id) on delete set null,
      api_key_id uuid references api_keys(id) on delete set null,
      status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed')),
      current_step text,
      progress jsonb not null default '{}'::jsonb,
      input jsonb not null default '{}'::jsonb,
      result jsonb,
      error text,
      created_at timestamptz not null default now(),
      started_at timestamptz,
      completed_at timestamptz,
      updated_at timestamptz not null default now()
    );

    create table if not exists document_indexing_runs (
      id uuid primary key default gen_random_uuid(),
      instance_id uuid not null references neo4j_instances(id) on delete cascade,
      status text not null check (status in ('succeeded', 'failed')),
      detail text,
      created_at timestamptz not null default now()
    );

    create index if not exists pipeline_jobs_user_id_idx on pipeline_jobs(user_id);
    create index if not exists pipeline_jobs_api_key_id_idx on pipeline_jobs(api_key_id);
    create index if not exists pipeline_jobs_status_idx on pipeline_jobs(status);
    create index if not exists document_indexing_runs_instance_id_idx on document_indexing_runs(instance_id);

    alter table users add column if not exists stripe_customer_id text;

    alter table neo4j_instances add column if not exists pvc_name text;
    alter table neo4j_instances add column if not exists last_backup_at timestamptz;
    alter table neo4j_instances add column if not exists last_error text;
    alter table neo4j_instances add column if not exists deleted_at timestamptz;

    alter table usage_events add column if not exists idempotency_key text;
    alter table usage_events add column if not exists request_id text;
    alter table usage_events add column if not exists job_id text;
    alter table usage_events add column if not exists source text;
    alter table usage_events add column if not exists event_type text;
    alter table usage_events add column if not exists billable_metric text;
    alter table usage_events add column if not exists quantity integer;
    alter table usage_events add column if not exists unit text;
    alter table usage_events add column if not exists unit_price_cents integer;
    alter table usage_events add column if not exists currency text not null default 'USD';
    alter table usage_events add column if not exists provider text;
    alter table usage_events add column if not exists model text;
    alter table usage_events add column if not exists metadata jsonb not null default '{}'::jsonb;
    alter table usage_events add column if not exists recorded_at timestamptz not null default now();

    alter table usage_events alter column endpoint drop not null;
    alter table usage_events alter column units drop not null;

    update usage_events
    set
      idempotency_key = coalesce(idempotency_key, 'legacy:' || id::text),
      source = coalesce(source, endpoint, 'legacy'),
      event_type = coalesce(event_type, 'legacy.usage.recorded'),
      billable_metric = coalesce(billable_metric, 'units'),
      quantity = coalesce(quantity, units, 0),
      unit = coalesce(unit, 'unit')
    where idempotency_key is null
      or source is null
      or event_type is null
      or billable_metric is null
      or quantity is null
      or unit is null;

    alter table usage_events alter column idempotency_key set not null;
    alter table usage_events alter column source set not null;
    alter table usage_events alter column event_type set not null;
    alter table usage_events alter column billable_metric set not null;
    alter table usage_events alter column quantity set not null;
    alter table usage_events alter column unit set not null;
    alter table usage_events alter column currency set not null;
    alter table usage_events alter column metadata set not null;
    alter table usage_events alter column recorded_at set not null;

    create index if not exists sessions_user_id_idx on sessions(user_id);
    create index if not exists sessions_expires_at_idx on sessions(expires_at);
    create index if not exists api_keys_user_id_idx on api_keys(user_id);
    create index if not exists neo4j_instances_user_id_idx on neo4j_instances(user_id);
    create index if not exists neo4j_instances_api_key_id_idx on neo4j_instances(api_key_id);
    create index if not exists neo4j_instances_status_idx on neo4j_instances(status);
    create unique index if not exists neo4j_instances_release_name_idx on neo4j_instances(release_name);
    create index if not exists billing_subscriptions_user_id_idx on billing_subscriptions(user_id);
    create unique index if not exists billing_subscriptions_provider_subscription_idx on billing_subscriptions(provider, provider_subscription_id);
    create index if not exists usage_events_user_time_idx on usage_events(user_id, occurred_at);
    create index if not exists usage_events_api_key_time_idx on usage_events(api_key_id, occurred_at);
    create unique index if not exists usage_events_idempotency_key_idx on usage_events(idempotency_key);
    create unique index if not exists billing_meter_events_usage_event_idx on billing_meter_events(usage_event_id);
    create unique index if not exists billing_meter_events_provider_identifier_idx on billing_meter_events(provider, provider_event_identifier);
    create index if not exists billing_meter_events_user_status_idx on billing_meter_events(user_id, status);
  `).then(() => undefined);

  return schemaReady;
}

export async function query<T extends pg.QueryResultRow>(
  text: string,
  values: unknown[] = [],
) {
  await ensureSchema();
  return getPool().query<T>(text, values);
}
