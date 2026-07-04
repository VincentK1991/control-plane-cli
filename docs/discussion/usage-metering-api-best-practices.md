# Usage Metering API Best Practices

Status: Discussion

Date: 2026-06-13

## Purpose

This note outlines practical options for tracking billable usage in the control
plane. It focuses on API-key based usage metering for workloads such as:

- file upload
- file processing
- document parsing
- vector indexing
- LLM inference
- background jobs
- user-facing API requests

The goal is not to pick one final architecture immediately. The goal is to make
the tradeoffs clear so the system can start simple without painting itself into
a corner.

## What We Need to Meter

Usage events should answer four questions:

- Who should be billed?
- Which API key, user, workspace, or tenant caused the usage?
- What product capability was used?
- How many billable units were consumed?

For this app, the first stable model is:

```text
api_key -> user -> usage_events -> billing summary
```

Later, this will probably become:

```text
api_key -> project/workspace -> organization/account -> invoice
```

## Core Principles

Metering should be append-first. Do not rely only on mutable counters.

Raw usage events are the source of truth. Aggregates and invoice totals should
be derived from those events, or at least traceable back to them.

Every billable action needs an idempotency key or event identity. Retried
requests and retried workers must not double bill.

Usage should be recorded as close as possible to the system that knows the real
cost. For LLM calls, that is after the provider returns token usage. For file
processing, that may be after parsing, OCR, chunking, embedding, or indexing
completes.

Billing should prefer correctness over low latency. Users can tolerate usage
dashboards that lag by seconds or minutes. They will not tolerate incorrect
invoices.

## Recommended Data Model

Start with an append-only `usage_events` table and a small number of stable
dimensions.

Suggested fields:

```text
id uuid primary key
idempotency_key text unique
user_id uuid not null
workspace_id uuid null
api_key_id uuid null
request_id text null
job_id text null
source text not null
event_type text not null
billable_metric text not null
quantity numeric not null
unit text not null
unit_price_cents numeric null
cost_cents numeric null
currency text not null default 'USD'
provider text null
model text null
metadata jsonb not null default '{}'
occurred_at timestamptz not null
recorded_at timestamptz not null default now()
```

Examples:

```text
event_type: llm.inference.completed
billable_metric: output_tokens
quantity: 1284
unit: token
provider: openai
model: gpt-5-mini
```

```text
event_type: file.processing.completed
billable_metric: pages_processed
quantity: 42
unit: page
metadata: {"mime_type":"application/pdf","bytes":1938472}
```

```text
event_type: vector.index.completed
billable_metric: embeddings
quantity: 800
unit: chunk
metadata: {"dimensions":1536}
```

Keep `metadata` for debugging and product-specific detail, but do not bury core
billing dimensions only inside JSON. Important dimensions should be first-class
columns.

## Sync Versus Async Metering

There are three main approaches.

## Option 1: Synchronous Metering in the Request Path

The API handler writes a `usage_events` row before returning to the caller.

Example:

```text
request -> authenticate API key -> do work -> insert usage event -> response
```

Pros:

- Simple to understand.
- Easy to debug locally.
- Usage is immediately visible.
- Works well for early product development.
- No queue or worker infrastructure required.

Cons:

- Adds database latency to user requests.
- If the database is down, product requests may fail or usage may be lost.
- Harder to handle long-running work.
- Risky for high-throughput APIs.

Best for:

- MVP
- low traffic
- simple API endpoints
- early dashboard visibility
- manually tested metering

This is what the current mock endpoint does.

## Option 2: Synchronous Outbox, Async Processing

The API handler writes a durable outbox row in the same database transaction as
the product action. A background worker later converts outbox rows into usage
events or billing aggregates.

Example:

```text
request -> do work + insert outbox event -> response
worker -> read outbox -> write usage_events -> mark outbox processed
```

Pros:

- Durable.
- Keeps request path fairly simple.
- Avoids losing events when the worker is down.
- Easier to retry safely.
- Good bridge from MVP to production.

Cons:

- Still writes to the database in the request path.
- Requires a worker.
- Requires idempotency and retry handling.
- Usage visibility may lag.

Best for:

- production small-to-medium scale
- file processing jobs
- background tasks
- systems where correctness matters more than instant usage display

This is the best next step after the current implementation.

## Option 3: Event Streaming

Services emit usage events to a stream such as Kafka, Pub/Sub, Kinesis, NATS, or
Redis Streams. Consumers validate, enrich, aggregate, and persist events.

Example:

```text
service -> emit usage event -> stream -> consumer -> warehouse/postgres/billing
```

Pros:

- Scales well.
- Decouples product systems from billing systems.
- Supports multiple consumers: billing, analytics, fraud, quota, observability.
- Good for high-volume event ingestion.

Cons:

- More infrastructure.
- More operational burden.
- Requires schema governance.
- Requires dead-letter queues and replay procedures.
- Harder to reason about for a small team.

Best for:

- high traffic
- many services
- multiple billing dimensions
- near-real-time analytics
- mature platform teams

Do not start here unless scale already justifies it.

## Event Sourcing

Metering should use event-sourcing ideas, but the whole application does not
need to become an event-sourced system.

Good event-sourcing practice for metering:

- append immutable usage events
- never edit a billable event after recording it
- use adjustment events to correct mistakes
- aggregate events into daily/monthly summaries
- preserve enough metadata to audit why a user was billed

Avoid:

- updating only counters with no raw event history
- deleting usage rows that contributed to an invoice
- relying on logs as the only billing source
- storing only provider invoice totals without request-level traceability

If a usage event is wrong, write a compensating event:

```text
usage.adjustment
quantity: -1000
reason: duplicate provider callback
```

## File Upload Metering

File upload has multiple possible billable moments.

Possible metrics:

- bytes uploaded
- files uploaded
- storage GB-hours
- pages processed
- OCR pages
- extracted text characters
- embeddings generated
- indexed chunks
- processing CPU seconds

Recommended flow:

```text
upload requested
file stored
file_processing job created
worker processes file
worker records usage events for actual completed work
```

Do not bill only on upload unless upload itself is the product. A PDF upload may
fail processing, be rejected, or contain fewer useful pages than expected.

Recommended events:

```text
file.upload.completed
file.processing.started
file.processing.completed
file.processing.failed
ocr.completed
embedding.completed
indexing.completed
```

Bill only completed billable work. Keep failed events for debugging and
operational metrics, but do not invoice failed work unless the pricing model
explicitly charges for attempts.

## LLM Inference Metering

LLM usage should be recorded after the model provider returns a response or
usage object.

Possible metrics:

- input tokens
- output tokens
- cached input tokens
- reasoning tokens
- images generated
- audio seconds
- tool calls
- model name
- provider
- latency

Recommended flow:

```text
request accepted
provider called
provider returns usage
record usage event with provider usage
return response
```

For streaming responses, usage may only be known at the end. Options:

- record after stream completes
- use provider final usage chunk if available
- record estimated usage first, then adjustment event later

Never trust client-reported token counts for billing. The server or provider
response must be authoritative.

Recommended LLM event:

```json
{
  "event_type": "llm.inference.completed",
  "billable_metric": "tokens",
  "quantity": 2500,
  "unit": "token",
  "provider": "openai",
  "model": "gpt-5-mini",
  "metadata": {
    "input_tokens": 1200,
    "output_tokens": 1000,
    "reasoning_tokens": 300,
    "request_id": "req_..."
  }
}
```

## Quotas and Rate Limits

Metering and quota enforcement are related but not identical.

Metering records what happened.

Quota checks decide whether something is allowed to happen.

At low maturity, quota can be checked with aggregate database queries:

```text
sum usage_events for user this month
```

At higher maturity, use precomputed aggregates:

```text
usage_daily
usage_monthly
```

At high maturity, use a low-latency counter store:

```text
Redis counters for live quota
Postgres/warehouse for billing truth
```

Do not make Redis the only billing source. It is useful for fast checks, not
for auditable invoices.

## Aggregates

Raw events should feed aggregate tables.

Useful aggregate tables:

```text
usage_daily
usage_monthly
usage_by_api_key_daily
usage_by_workspace_daily
```

Aggregates should be rebuildable from raw events.

Use aggregates for:

- dashboard charts
- quota checks
- invoice previews
- account usage summaries

Use raw events for:

- audit
- dispute resolution
- replay
- invoice reconstruction

## Idempotency

Every usage-producing operation should have a stable idempotency key.

Examples:

```text
request:{request_id}:llm.inference.completed
job:{job_id}:file.processing.completed
provider:{provider_request_id}:llm.usage
```

Database constraint:

```text
unique(idempotency_key)
```

Without this, retries can double bill.

Idempotency is especially important for:

- worker retries
- provider webhook retries
- client retries
- network timeouts
- streaming responses

## Maturity Model

## Stage 0: Prototype

Shape:

- One Postgres table: `usage_events`
- Write usage synchronously in API route
- Simple dashboard sums
- No formal invoice generation

Good enough when:

- usage is low
- product is not charging real money yet
- team needs visibility quickly

Risk:

- duplicate events
- request latency
- limited audit model

## Stage 1: MVP With Real Users

Shape:

- append-only `usage_events`
- idempotency keys
- API key ownership
- session-authenticated dashboard
- daily/monthly aggregate queries
- manual invoice review

Add:

- `workspace_id` or `account_id`
- first-class metric names
- explicit `unit`
- explicit `provider` and `model`
- adjustment events

Good enough when:

- usage is real but moderate
- billing can tolerate manual review
- one backend owns most events

## Stage 2: Production

Shape:

- durable outbox
- background usage worker
- aggregate tables
- quota checks
- invoice preview
- replay tooling
- admin audit views

Add:

- `usage_outbox`
- `usage_daily`
- `usage_monthly`
- dead-letter state for failed processing
- backfill scripts
- reconciliation jobs

Good enough when:

- customers are billed from usage
- workers process files and async jobs
- correctness matters more than immediate usage display

This is the likely target for the control plane after MVP.

## Stage 3: Platform Scale

Shape:

- event stream
- schema registry or strict event contracts
- multiple consumers
- warehouse sink
- billing sink
- fraud/abuse sink
- near-real-time counters

Add:

- Kafka/Pub/Sub/Kinesis/NATS
- dead-letter queues
- replay from offsets
- event versioning
- data warehouse tables
- reconciliation against provider invoices

Good enough when:

- many services emit usage
- traffic is high
- analytics and billing both depend on events
- usage pipelines need independent scaling

## Recommendation for This Project

Use this progression:

1. Keep the current synchronous `usage_events` write for the mock endpoint.
2. Add `idempotency_key`, `workspace_id`, `event_type`, `billable_metric`,
   `quantity`, `unit`, `provider`, `model`, and `metadata`.
3. For file processing, record usage from the worker after each completed stage.
4. For LLM inference, record usage after the provider returns actual usage.
5. Before real billing, add an outbox and aggregate tables.
6. Defer event streaming until multiple services or high volume make it worth
   the operational cost.

The near-term production design should be:

```text
API request or worker
  -> authenticate user/API key
  -> perform work
  -> insert durable usage event or outbox row with idempotency key
  -> background job builds aggregates
  -> billing reads aggregates and can audit raw events
```

This gives us correctness, auditability, and a clear path to scale without
starting with unnecessary infrastructure.
