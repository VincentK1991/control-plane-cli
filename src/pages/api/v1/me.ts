import type { APIRoute } from "astro";
import { getApiKeyById } from "../../../lib/apiKeys";
import { json, requireApiKey } from "../../../lib/responses";

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const { auth, response } = await requireApiKey(request);
  if (!auth) {
    return response;
  }

  const apiKey = await getApiKeyById(auth.api_key_id);
  if (!apiKey) {
    return json({ error: "API key not found." }, { status: 404 });
  }

  return json({
    user_id: auth.user_id,
    api_key_id: auth.api_key_id,
    key_prefix: apiKey.key_prefix,
    name: apiKey.name,
  });
};
