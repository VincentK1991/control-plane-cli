import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import type { User } from "../auth";
import { query } from "../db";
import { requireEnv } from "../env";

const BILLING_PROVIDER = "stripe";

type BillingSubscriptionRow = {
  id: string;
  provider: string;
  provider_customer_id: string;
  provider_subscription_id: string | null;
  status: string;
  price_id: string | null;
  current_period_start: Date | null;
  current_period_end: Date | null;
  cancel_at: Date | null;
  canceled_at: Date | null;
  updated_at: Date;
};

type BillingSyncSummaryRow = {
  status: string;
  count: string;
};

type StripeCustomerRow = {
  stripe_customer_id: string | null;
};

type UsageEventForBilling = {
  id: string;
  idempotency_key: string;
  user_id: string;
  quantity: number;
  occurred_at: Date;
  stripe_customer_id: string | null;
  subscription_status: string | null;
};

let stripeClient: Stripe | undefined;

function stripeEnv(name: string) {
  return process.env[name]?.trim() || null;
}

export function isBillingConfigured() {
  return Boolean(
    stripeEnv("STRIPE_SECRET_KEY") &&
      stripeEnv("STRIPE_PRICE_ID") &&
      stripeEnv("STRIPE_METER_EVENT_NAME"),
  );
}

function getStripe() {
  stripeClient ??= new Stripe(requireEnv("STRIPE_SECRET_KEY"));
  return stripeClient;
}

function getAppUrl(origin: string) {
  return stripeEnv("PUBLIC_APP_URL") ?? origin;
}

function fromStripeTimestamp(timestamp: number | null | undefined) {
  return timestamp ? new Date(timestamp * 1000) : null;
}

async function getOrCreateStripeCustomer(user: User) {
  const existing = await query<StripeCustomerRow>(
    "select stripe_customer_id from users where id = $1 limit 1",
    [user.id],
  );
  const existingCustomerId = existing.rows[0]?.stripe_customer_id;

  if (existingCustomerId) {
    return existingCustomerId;
  }

  const customer = await getStripe().customers.create({
    email: user.email,
    name: user.name ?? undefined,
    metadata: {
      user_id: user.id,
      google_sub: user.google_sub,
    },
  });

  await query("update users set stripe_customer_id = $1, updated_at = now() where id = $2", [
    customer.id,
    user.id,
  ]);

  return customer.id;
}

export async function createCheckoutSession(user: User, origin: string) {
  const priceId = requireEnv("STRIPE_PRICE_ID");
  const appUrl = getAppUrl(origin);
  const customerId = await getOrCreateStripeCustomer(user);
  const session = await getStripe().checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    client_reference_id: user.id,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${appUrl}/?billing=success`,
    cancel_url: `${appUrl}/?billing=cancelled`,
    subscription_data: {
      metadata: {
        user_id: user.id,
      },
    },
    metadata: {
      user_id: user.id,
    },
  });

  return session.url;
}

export async function createBillingPortalSession(user: User, origin: string) {
  const customerId = await getOrCreateStripeCustomer(user);
  const appUrl = getAppUrl(origin);
  const session = await getStripe().billingPortal.sessions.create({
    customer: customerId,
    return_url: appUrl,
  });

  return session.url;
}

export async function getBillingStatus(userId: string) {
  const subscriptionResult = await query<BillingSubscriptionRow>(
    `
      select
        id,
        provider,
        provider_customer_id,
        provider_subscription_id,
        status,
        price_id,
        current_period_start,
        current_period_end,
        cancel_at,
        canceled_at,
        updated_at
      from billing_subscriptions
      where user_id = $1
      order by updated_at desc
      limit 1
    `,
    [userId],
  );

  const syncResult = await query<BillingSyncSummaryRow>(
    `
      select status, count(*)::text as count
      from billing_meter_events
      where user_id = $1
      group by status
    `,
    [userId],
  );

  return {
    configured: isBillingConfigured(),
    provider: BILLING_PROVIDER,
    subscription: subscriptionResult.rows[0] ?? null,
    meter_sync: syncResult.rows.reduce<Record<string, string>>((summary, row) => {
      summary[row.status] = row.count;
      return summary;
    }, {}),
  };
}

async function markBillingMeterEvent({
  usageEventId,
  userId,
  identifier,
  status,
  error,
}: {
  usageEventId: string;
  userId: string;
  identifier: string;
  status: "synced" | "failed" | "skipped";
  error?: string | null;
}) {
  await query(
    `
      insert into billing_meter_events (
        id,
        usage_event_id,
        user_id,
        provider,
        provider_event_identifier,
        status,
        attempts,
        last_error,
        synced_at
      )
      values ($1, $2, $3, $4, $5, $6, 1, $7, case when $6 = 'synced' then now() else null end)
      on conflict (usage_event_id) do update set
        status = excluded.status,
        attempts = billing_meter_events.attempts + 1,
        last_error = excluded.last_error,
        synced_at = excluded.synced_at,
        updated_at = now()
    `,
    [
      randomUUID(),
      usageEventId,
      userId,
      BILLING_PROVIDER,
      identifier,
      status,
      error ?? null,
    ],
  );
}

export async function publishUsageEventToBilling(usageEventId: string) {
  const result = await query<UsageEventForBilling>(
    `
      select
        ue.id,
        ue.idempotency_key,
        ue.user_id,
        ue.quantity,
        ue.occurred_at,
        u.stripe_customer_id,
        subscription.status as subscription_status
      from usage_events ue
      join users u on u.id = ue.user_id
      left join lateral (
        select status
        from billing_subscriptions
        where user_id = ue.user_id
          and provider = $2
        order by updated_at desc
        limit 1
      ) subscription on true
      where ue.id = $1
      limit 1
    `,
    [usageEventId, BILLING_PROVIDER],
  );

  const usageEvent = result.rows[0];

  if (!usageEvent) {
    return;
  }

  const mark = (status: "synced" | "failed" | "skipped", error?: string) =>
    markBillingMeterEvent({
      usageEventId,
      userId: usageEvent.user_id,
      identifier: usageEvent.idempotency_key,
      status,
      error,
    });

  if (!isBillingConfigured()) {
    await mark("skipped", "Stripe billing is not configured.");
    return;
  }

  if (!usageEvent.stripe_customer_id) {
    await mark("skipped", "User does not have a Stripe customer.");
    return;
  }

  if (!["active", "trialing"].includes(usageEvent.subscription_status ?? "")) {
    await mark("skipped", "User does not have an active billing subscription.");
    return;
  }

  try {
    await getStripe().v2.billing.meterEvents.create({
      event_name: requireEnv("STRIPE_METER_EVENT_NAME"),
      identifier: usageEvent.idempotency_key,
      timestamp: usageEvent.occurred_at.toISOString(),
      payload: {
        stripe_customer_id: usageEvent.stripe_customer_id,
        value: String(usageEvent.quantity),
      },
    });
    await mark("synced");
  } catch (error) {
    await mark(
      "failed",
      error instanceof Error ? error.message : "Stripe meter event sync failed.",
    );
  }
}

async function upsertSubscriptionFromStripe(subscription: Stripe.Subscription) {
  const subscriptionWithPeriods = subscription as Stripe.Subscription & {
    current_period_start?: number | null;
    current_period_end?: number | null;
  };
  const customerId =
    typeof subscription.customer === "string"
      ? subscription.customer
      : subscription.customer.id;
  const userResult = await query<{ id: string }>(
    "select id from users where stripe_customer_id = $1 limit 1",
    [customerId],
  );
  const userId = userResult.rows[0]?.id ?? subscription.metadata.user_id;

  if (!userId) {
    return;
  }

  await query(
    `
      insert into billing_subscriptions (
        id,
        user_id,
        provider,
        provider_customer_id,
        provider_subscription_id,
        status,
        price_id,
        current_period_start,
        current_period_end,
        cancel_at,
        canceled_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      on conflict (provider, provider_subscription_id) do update set
        status = excluded.status,
        price_id = excluded.price_id,
        current_period_start = excluded.current_period_start,
        current_period_end = excluded.current_period_end,
        cancel_at = excluded.cancel_at,
        canceled_at = excluded.canceled_at,
        updated_at = now()
    `,
    [
      randomUUID(),
      userId,
      BILLING_PROVIDER,
      customerId,
      subscription.id,
      subscription.status,
      subscription.items.data[0]?.price.id ?? null,
      fromStripeTimestamp(subscriptionWithPeriods.current_period_start),
      fromStripeTimestamp(subscriptionWithPeriods.current_period_end),
      fromStripeTimestamp(subscription.cancel_at),
      fromStripeTimestamp(subscription.canceled_at),
    ],
  );
}

export async function handleStripeWebhook(rawBody: string, signature: string | null) {
  if (!signature) {
    throw new Error("Missing Stripe-Signature header.");
  }

  const event = getStripe().webhooks.constructEvent(
    rawBody,
    signature,
    requireEnv("STRIPE_WEBHOOK_SECRET"),
  );

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    if (typeof session.subscription === "string") {
      const subscription = await getStripe().subscriptions.retrieve(
        session.subscription,
      );
      await upsertSubscriptionFromStripe(subscription);
    }
  }

  if (
    event.type === "customer.subscription.created" ||
    event.type === "customer.subscription.updated" ||
    event.type === "customer.subscription.deleted"
  ) {
    await upsertSubscriptionFromStripe(event.data.object as Stripe.Subscription);
  }

  return { received: true, type: event.type };
}
