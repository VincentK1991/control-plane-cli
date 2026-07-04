import type { APIRoute } from "astro";
import {
  authenticateApiKey,
  readIdempotencyKey,
  readBearerToken,
  recordUsageEvent,
} from "../../../lib/metering";
import { publishUsageEventToBilling } from "../../../lib/billing";
import { json, readJson } from "../../../lib/responses";

type UsageEventBody = {
  idempotency_key?: string;
  source?: string;
  event_type?: string;
  billable_metric?: string;
  quantity?: number;
  unit?: string;
  unit_price_cents?: number | null;
  cost_cents?: number;
  request_id?: string | null;
  job_id?: string | null;
  provider?: string | null;
  model?: string | null;
  metadata?: Record<string, unknown>;
};

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const bearerToken = readBearerToken(request);

  if (!bearerToken) {
    return json({ error: "Missing bearer API key." }, { status: 401 });
  }

  const authenticated = await authenticateApiKey(bearerToken);

  if (!authenticated) {
    return json({ error: "Invalid or revoked API key." }, { status: 401 });
  }

  const body = await readJson<UsageEventBody>(request);
  const idempotencyKey =
    readIdempotencyKey(request) ?? body?.idempotency_key?.trim();
  const source = body?.source?.trim();
  const eventType = body?.event_type?.trim();
  const billableMetric = body?.billable_metric?.trim();
  const quantity = Number(body?.quantity ?? 1);
  const unit = body?.unit?.trim();
  const unitPriceCents =
    body?.unit_price_cents === null || body?.unit_price_cents === undefined
      ? null
      : Number(body.unit_price_cents);
  const costCents = Number(body?.cost_cents ?? 0);
  const requestId = body?.request_id?.trim() || null;
  const jobId = body?.job_id?.trim() || null;

  if (!idempotencyKey || idempotencyKey.length > 200) {
    return json(
      { error: "Idempotency key is required and must be 200 characters or less." },
      { status: 400 },
    );
  }

  if (!source || source.length > 160) {
    return json(
      { error: "Usage event source is required and must be 160 characters or less." },
      { status: 400 },
    );
  }

  if (!eventType || eventType.length > 120) {
    return json(
      { error: "Usage event_type is required and must be 120 characters or less." },
      { status: 400 },
    );
  }

  if (!billableMetric || billableMetric.length > 80) {
    return json(
      { error: "Usage billable_metric is required and must be 80 characters or less." },
      { status: 400 },
    );
  }

  if (!unit || unit.length > 40) {
    return json(
      { error: "Usage unit is required and must be 40 characters or less." },
      { status: 400 },
    );
  }

  if (!Number.isInteger(quantity) || quantity < 0 || quantity > 1_000_000) {
    return json({ error: "Usage quantity must be an integer from 0 to 1000000." }, { status: 400 });
  }

  if (
    unitPriceCents !== null &&
    (!Number.isInteger(unitPriceCents) || unitPriceCents < 0 || unitPriceCents > 100_000_000)
  ) {
    return json(
      { error: "Usage unit_price_cents must be an integer from 0 to 100000000." },
      { status: 400 },
    );
  }

  if (!Number.isInteger(costCents) || costCents < 0 || costCents > 100_000_000) {
    return json(
      { error: "Usage cost_cents must be an integer from 0 to 100000000." },
      { status: 400 },
    );
  }

  const usageEvent = await recordUsageEvent({
    idempotencyKey,
    userId: authenticated.user_id,
    apiKeyId: authenticated.api_key_id,
    requestId,
    jobId,
    source,
    eventType,
    billableMetric,
    quantity,
    unit,
    unitPriceCents,
    costCents,
    provider: body?.provider ?? null,
    model: body?.model ?? null,
    metadata: body?.metadata ?? {},
  });

  if (usageEvent.inserted && usageEvent.id) {
    await publishUsageEventToBilling(usageEvent.id);
  }

  return json({ ok: true, recorded: usageEvent.inserted });
};
