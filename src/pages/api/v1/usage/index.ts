import type { APIRoute } from "astro";
import { getUsageSummaryForApiKey } from "../../../../lib/apiKeys";
import { json, requireApiKey } from "../../../../lib/responses";

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const { auth, response } = await requireApiKey(request);
  if (!auth) {
    return response;
  }

  const usage = await getUsageSummaryForApiKey(auth.api_key_id);
  return json({ usage });
};
