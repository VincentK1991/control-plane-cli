import type { APIRoute } from "astro";
import { getBillingStatus } from "../../../lib/billing";
import { json, requireUser } from "../../../lib/responses";

export const prerender = false;

export const GET: APIRoute = async ({ cookies }) => {
  const { user, response } = await requireUser(cookies);

  if (response) {
    return response;
  }

  return json({ billing: await getBillingStatus(user.id) });
};
