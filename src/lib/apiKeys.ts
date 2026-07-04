import { randomUUID } from "node:crypto";
import { hashApiKey, randomToken } from "./crypto";
import { query } from "./db";

export type ApiKeyRecord = {
  id: string;
  name: string;
  key_prefix: string;
  status: "active" | "revoked";
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
  revoked_at: string | null;
};

export type UsageSummary = {
  total_events: string;
  total_units: string;
  total_cost_cents: string;
};

export function mintApiKeyValue() {
  const prefix = `cp_live_${randomToken(6)}`;
  const secret = randomToken(32);

  return {
    apiKey: `${prefix}_${secret}`,
    prefix,
  };
}

export async function getApiKeyById(apiKeyId: string) {
  const result = await query<ApiKeyRecord>(
    `
      select id, name, key_prefix, status, last_used_at, expires_at, created_at, revoked_at
      from api_keys
      where id = $1
      limit 1
    `,
    [apiKeyId],
  );

  return result.rows[0] ?? null;
}

export async function listApiKeys(userId: string) {
  const result = await query<ApiKeyRecord>(
    `
      select id, name, key_prefix, status, last_used_at, expires_at, created_at, revoked_at
      from api_keys
      where user_id = $1
      order by created_at desc
    `,
    [userId],
  );

  return result.rows;
}

export async function createApiKey(userId: string, name: string) {
  const { apiKey, prefix } = mintApiKeyValue();
  const result = await query<ApiKeyRecord>(
    `
      insert into api_keys (id, user_id, name, key_prefix, key_hash, status)
      values ($1, $2, $3, $4, $5, 'active')
      returning id, name, key_prefix, status, last_used_at, expires_at, created_at, revoked_at
    `,
    [randomUUID(), userId, name, prefix, hashApiKey(apiKey)],
  );

  return {
    record: result.rows[0],
    apiKey,
  };
}

export async function renameApiKey(userId: string, apiKeyId: string, name: string) {
  const result = await query<ApiKeyRecord>(
    `
      update api_keys
      set name = $3
      where id = $1 and user_id = $2
      returning id, name, key_prefix, status, last_used_at, expires_at, created_at, revoked_at
    `,
    [apiKeyId, userId, name],
  );

  return result.rows[0] ?? null;
}

export async function revokeApiKey(userId: string, apiKeyId: string) {
  const result = await query<ApiKeyRecord>(
    `
      update api_keys
      set status = 'revoked', revoked_at = coalesce(revoked_at, now())
      where id = $1 and user_id = $2
      returning id, name, key_prefix, status, last_used_at, expires_at, created_at, revoked_at
    `,
    [apiKeyId, userId],
  );

  return result.rows[0] ?? null;
}

export async function getUsageSummary(userId: string) {
  const result = await query<UsageSummary>(
    `
      select
        count(*)::text as total_events,
        coalesce(sum(quantity), 0)::text as total_units,
        coalesce(sum(cost_cents), 0)::text as total_cost_cents
      from usage_events
      where user_id = $1
    `,
    [userId],
  );

  return result.rows[0];
}

export async function getUsageSummaryForApiKey(apiKeyId: string) {
  const result = await query<UsageSummary>(
    `
      select
        count(*)::text as total_events,
        coalesce(sum(quantity), 0)::text as total_units,
        coalesce(sum(cost_cents), 0)::text as total_cost_cents
      from usage_events
      where api_key_id = $1
    `,
    [apiKeyId],
  );

  return result.rows[0];
}
