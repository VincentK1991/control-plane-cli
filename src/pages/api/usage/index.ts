import type { APIRoute } from "astro";
import { getUsageSummary } from "../../../lib/apiKeys";
import { json, requireUser } from "../../../lib/responses";

export const prerender = false;

export const GET: APIRoute = async ({ cookies }) => {
  const { user, response } = await requireUser(cookies);

  if (!user) {
    return response;
  }

  return json({ usage: await getUsageSummary(user.id) });
};
