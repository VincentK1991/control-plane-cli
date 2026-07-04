import type { APIRoute } from "astro";
import { createCheckoutSession, isBillingConfigured } from "../../../lib/billing";
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

  const checkoutUrl = await createCheckoutSession(user, url.origin);

  if (!checkoutUrl) {
    return json({ error: "Stripe did not return a checkout URL." }, { status: 502 });
  }

  return json({ url: checkoutUrl });
};
