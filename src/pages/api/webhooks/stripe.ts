import type { APIRoute } from "astro";
import { handleStripeWebhook } from "../../../lib/billing";
import { json } from "../../../lib/responses";

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature");

  try {
    return json(await handleStripeWebhook(rawBody, signature));
  } catch (error) {
    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Stripe webhook could not be processed.",
      },
      { status: 400 },
    );
  }
};
