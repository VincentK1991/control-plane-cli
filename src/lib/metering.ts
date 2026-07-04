import { randomUUID } from "node:crypto";
import { hashApiKey } from "./crypto";
import { query } from "./db";

type AuthenticatedApiKey = {
  api_key_id: string;
  user_id: string;
};

export function readBearerToken(request: Request) {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

export function readIdempotencyKey(request: Request) {
  return request.headers.get("idempotency-key")?.trim() || null;
}

export async function authenticateApiKey(apiKey: string) {
  const result = await query<AuthenticatedApiKey>(
    `
      select id as api_key_id, user_id
      from api_keys
      where key_hash = $1
        and status = 'active'
        and (expires_at is null or expires_at > now())
      limit 1
    `,
    [hashApiKey(apiKey)],
  );
  return result.rows[0] ?? null;
}

export async function recordUsageEvent({
  idempotencyKey,
  userId,
  apiKeyId,
  requestId = null,
  jobId = null,
  source,
  eventType,
  billableMetric,
  quantity,
  unit,
  unitPriceCents = null,
  costCents,
  currency = "USD",
  provider = null,
  model = null,
  metadata = {},
}: {
  idempotencyKey: string;
  userId: string;
  apiKeyId: string;
  requestId?: string | null;
  jobId?: string | null;
  source: string;
  eventType: string;
  billableMetric: string;
  quantity: number;
  unit: string;
  unitPriceCents?: number | null;
  costCents: number;
  currency?: string;
  provider?: string | null;
  model?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const result = await query<{ id: string }>(
    `
      insert into usage_events (
        id,
        idempotency_key,
        user_id,
        api_key_id,
        endpoint,
        units,
        request_id,
        job_id,
        source,
        event_type,
        billable_metric,
        quantity,
        unit,
        unit_price_cents,
        cost_cents,
        currency,
        provider,
        model,
        metadata
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb)
      on conflict (idempotency_key) do nothing
      returning id
    `,
    [
      randomUUID(),
      idempotencyKey,
      userId,
      apiKeyId,
      source,
      quantity,
      requestId,
      jobId,
      source,
      eventType,
      billableMetric,
      quantity,
      unit,
      unitPriceCents,
      costCents,
      currency,
      provider,
      model,
      JSON.stringify(metadata),
    ],
  );

  const inserted = (result.rowCount ?? 0) > 0;

  if (inserted) {
    await query("update api_keys set last_used_at = now() where id = $1", [
      apiKeyId,
    ]);
  }

  return {
    inserted,
    id: result.rows[0]?.id ?? null,
  };
}
