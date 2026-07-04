# Stripe Billing Setup

This app uses Stripe in test mode for mock billing:

- Google login creates a local user.
- The Billing panel starts a Stripe Checkout subscription.
- Stripe webhooks update local subscription state.
- Local `usage_events` remain the billing audit ledger.
- Synced meter events are tracked in `billing_meter_events`.

Do not use live-mode Stripe keys until the test-mode flow is verified end to
end.

## 1. Create or Open a Stripe Account

1. Go to <https://dashboard.stripe.com/register> and create an account, or sign
   in at <https://dashboard.stripe.com>.
2. Stay in test mode. Stripe test objects and live objects are separate.
3. Open the test dashboard. Most dashboard URLs should include `/test/`.

Stripe test keys start with:

- `sk_test_` for secret keys
- `pk_test_` for publishable keys
- `rk_test_` for restricted keys

This backend only needs a server-side key. Do not put `sk_` or `rk_` keys in
frontend code.

## 2. Create the Stripe API Key

For the local prototype, a test secret key is the fastest path.

1. Open <https://dashboard.stripe.com/test/apikeys>.
2. Copy the test secret key, or create a new test secret key.
3. Put it in `.env`:

```bash
STRIPE_SECRET_KEY=sk_test_replace_me
```

For production, prefer a restricted API key instead of a broad secret key. It
must be able to create customers, checkout sessions, billing portal sessions,
retrieve subscriptions, and create billing meter events.

## 3. Create a Product

1. Open the Stripe Dashboard in test mode.
2. Go to **Product catalog**.
3. Click **Add product**.
4. Name it something like `Control Plane API`.
5. Save the product.

## 4. Create a Billing Meter

The code sends usage through Stripe meter events with these payload keys:

- `stripe_customer_id`
- `value`

It also sends the event name from `STRIPE_METER_EVENT_NAME`.

1. In the Stripe Dashboard, go to **Billing** and find **Meters** or **Usage-based billing**.
2. Create a meter.
3. Set the event name to:

```bash
mock_inference_tokens
```

4. Keep the customer mapping payload key as:

```bash
stripe_customer_id
```

5. Keep the value payload key as:

```bash
value
```

6. Save the meter.
7. Put the same event name in `.env`:

```bash
STRIPE_METER_EVENT_NAME=mock_inference_tokens
```

## 5. Create a Metered Price

1. Open the product you created.
2. Add a recurring price.
3. Choose usage-based or metered billing.
4. Attach the price to the meter from the previous step.
5. Pick a simple test price, for example a small amount per token or per unit.
6. Copy the Price ID. It starts with `price_`.
7. Put it in `.env`:

```bash
STRIPE_PRICE_ID=price_replace_me
```

The app passes this value to Stripe Checkout in
`src/lib/billing/index.ts`.

## 6. Configure Local Environment

Make sure `.env` has these values:

```bash
PUBLIC_APP_URL=http://127.0.0.1:4321

BILLING_PROVIDER=stripe
STRIPE_SECRET_KEY=sk_test_replace_me
STRIPE_WEBHOOK_SECRET=whsec_replace_me
STRIPE_PRICE_ID=price_replace_me
STRIPE_METER_EVENT_NAME=mock_inference_tokens
```

Then apply database migrations:

```bash
just db
just db-migrate
```

Use `just db-generate` only after changing `src/db/schema.ts`.

## 7. Install and Login to the Stripe CLI

Install the Stripe CLI if needed:

```bash
brew install stripe/stripe-cli/stripe
```

Login:

```bash
stripe login
```

The browser will ask you to authorize the CLI against your Stripe account.

## 8. Forward Webhooks to the Local App

Start the app:

```bash
just web
```

In a second terminal, run:

```bash
stripe listen --forward-to localhost:4321/api/webhooks/stripe
```

The CLI prints a signing secret that starts with `whsec_`.

Copy that value into `.env`:

```bash
STRIPE_WEBHOOK_SECRET=whsec_replace_me
```

Restart `just web` after updating `.env`.

The current webhook handler expects these Stripe events:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`

For the local CLI listener, forwarding all events is acceptable. For a deployed
webhook endpoint, subscribe only to the event types the app handles.

## 9. Test the Checkout Flow

1. Open <http://127.0.0.1:4321>.
2. Sign in with Google.
3. In the dashboard, open the **Billing** panel.
4. Click **Start Checkout**.
5. Use a Stripe test card:

```text
4242 4242 4242 4242
```

Use any future expiration date, any CVC, and any ZIP code.

6. Complete Checkout.
7. Return to the app.
8. Click **Refresh** in the Billing panel.
9. Confirm the subscription status is `active`.

The webhook writes subscription state to `billing_subscriptions`.

## 10. Test Metered Usage

1. Mint an API key in the dashboard.
2. Copy the key.
3. Call the mock inference endpoint:

```bash
curl -sS http://127.0.0.1:4321/api/mock/inference \
  -H "Authorization: Bearer cp_live_your_key_here" \
  -H "Idempotency-Key: test_request_001" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Summarize usage for this workspace"}'
```

4. Check local usage:

```bash
docker exec control-plane-postgres psql -U postgres -d control_plane \
  -c "select idempotency_key, quantity, cost_cents from usage_events order by occurred_at desc limit 5;"
```

5. Check Stripe sync state:

```bash
docker exec control-plane-postgres psql -U postgres -d control_plane \
  -c "select provider_event_identifier, status, attempts, last_error from billing_meter_events order by created_at desc limit 5;"
```

Expected result:

- `usage_events` has one row for the request.
- `billing_meter_events.status` is `synced` if the user has an active Stripe
  subscription.
- Reusing the same `Idempotency-Key` must not double bill.

## 11. Troubleshooting

### Billing panel says Stripe is not configured

Check:

```bash
STRIPE_SECRET_KEY
STRIPE_PRICE_ID
STRIPE_METER_EVENT_NAME
```

Restart `just web` after changing `.env`.

### Checkout opens but subscription never becomes active

Check that the Stripe CLI is running:

```bash
stripe listen --forward-to localhost:4321/api/webhooks/stripe
```

Check that `.env` contains the latest `whsec_` value printed by the CLI.

### Usage is recorded but Stripe sync is skipped

Look at `billing_meter_events.last_error`.

Common reasons:

- The user has not completed Checkout.
- The local user does not have `stripe_customer_id`.
- The subscription is not `active` or `trialing`.
- Stripe env vars are missing.

### Stripe reports no meter found

The value of `STRIPE_METER_EVENT_NAME` must exactly match the meter event name
configured in Stripe.

### Stripe reports missing customer or value payload

The meter must use these payload keys:

```text
stripe_customer_id
value
```

That matches the payload sent by `publishUsageEventToBilling()` in
`src/lib/billing/index.ts`.

## 12. Production Notes

Before live billing:

- Use restricted API keys where possible.
- Store Stripe keys in a secrets manager, not `.env` files.
- Use HTTPS for deployed webhook endpoints.
- Subscribe deployed webhooks only to supported event types.
- Add handling for meter error webhooks:
  - `v1.billing.meter.error_report_triggered`
  - `v1.billing.meter.no_meter_found`
- Move Stripe meter submission out of the request path into an async outbox or
  worker if usage volume grows.
- Reconcile Stripe invoices against local `usage_events` and
  `billing_meter_events`.

References:

- Stripe API keys: <https://docs.stripe.com/keys>
- Stripe webhooks: <https://docs.stripe.com/webhooks>
- Stripe usage recording: <https://docs.stripe.com/billing/subscriptions/usage-based/recording-usage-api>
