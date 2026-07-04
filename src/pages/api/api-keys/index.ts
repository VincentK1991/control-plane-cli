import type { APIRoute } from "astro";
import { createApiKey, listApiKeys } from "../../../lib/apiKeys";
import { json, readJson, requireUser } from "../../../lib/responses";

type CreateApiKeyBody = {
  name?: string;
};

export const prerender = false;

export const GET: APIRoute = async ({ cookies }) => {
  const { user, response } = await requireUser(cookies);

  if (!user) {
    return response;
  }

  return json({ apiKeys: await listApiKeys(user.id) });
};

export const POST: APIRoute = async ({ request, cookies }) => {
  const { user, response } = await requireUser(cookies);

  if (!user) {
    return response;
  }

  const body = await readJson<CreateApiKeyBody>(request);
  const name = body?.name?.trim();

  if (!name) {
    return json({ error: "API key name is required." }, { status: 400 });
  }

  if (name.length > 80) {
    return json({ error: "API key name must be 80 characters or less." }, { status: 400 });
  }

  const created = await createApiKey(user.id, name);

  return json({
    apiKey: created.record,
    token: created.apiKey,
  });
};
