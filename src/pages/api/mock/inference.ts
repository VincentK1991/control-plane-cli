import type { APIRoute } from "astro";
import {
  authenticateApiKey,
  readIdempotencyKey,
  readBearerToken,
  recordUsageEvent,
} from "../../../lib/metering";
import { publishUsageEventToBilling } from "../../../lib/billing";
import { json, readJson } from "../../../lib/responses";

type MockInferenceBody = {
  prompt?: string;
};

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const requestId = crypto.randomUUID();
  const bearerToken = readBearerToken(request);

  if (!bearerToken) {
    return json({ error: "Missing bearer API key." }, { status: 401 });
  }

  const authenticated = await authenticateApiKey(bearerToken);

  if (!authenticated) {
    return json({ error: "Invalid or revoked API key." }, { status: 401 });
  }

  const body = await readJson<MockInferenceBody>(request);
  const prompt = body?.prompt?.trim();

  if (!prompt) {
    return json({ error: "Prompt is required." }, { status: 400 });
  }

  if (prompt.length > 4000) {
    return json({ error: "Prompt must be 4000 characters or less." }, { status: 400 });
  }

  const units = Math.max(1, Math.ceil(prompt.length / 4));
  const costCents = Math.ceil(units / 100);
  const idempotencyKey =
    readIdempotencyKey(request) ?? `mock-inference:${requestId}`;

  const usageEvent = await recordUsageEvent({
    idempotencyKey,
    userId: authenticated.user_id,
    apiKeyId: authenticated.api_key_id,
    requestId,
    source: "/api/mock/inference",
    eventType: "llm.inference.completed",
    billableMetric: "tokens",
    quantity: units,
    unit: "token",
    unitPriceCents: 1,
    costCents,
    provider: "mock",
    model: "mock-inference-v1",
    metadata: {
      prompt_characters: prompt.length,
      idempotency_source: readIdempotencyKey(request) ? "client" : "server",
    },
  });

  if (usageEvent.inserted && usageEvent.id) {
    await publishUsageEventToBilling(usageEvent.id);
  }

  return json({
    id: requestId,
    object: "mock.inference",
    output: `Mock response for: ${prompt}`,
    usage: {
      units,
      billable_metric: "tokens",
      unit: "token",
      cost_cents: costCents,
      recorded: usageEvent.inserted,
    },
  });
};
