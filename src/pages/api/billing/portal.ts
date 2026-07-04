import type { APIRoute } from "astro";
import { createBillingPortalSession, isBillingConfigured } from "../../../lib/billing";
import { json, requireUser } from "../../../lib/responses";

export const prerender = false;

export const POST: APIRoute = async ({ cookies, url }) => {
  const { user, response } = await requireUser(cookies);

  if (response) {
    return response;
  }

  if (!isBillingConfigured()) {
    return json(
      { error: "Stripe billing is not configured. Check Stripe env vars." },
      { status: 503 },
    );
  }

  const portalUrl = await createBillingPortalSession(user, url.origin);

  if (!portalUrl) {
    return json({ error: "Stripe did not return a portal URL." }, { status: 502 });
  }

  return json({ url: portalUrl });
};
