# Pipeline Orchestration: Dagster vs Temporal

Status: Discussion

Date: 2026-07-03

## Purpose

Before scaffolding a `pipelines/` monorepo for indexing data into
control-plane-provisioned databases (starting with Neo4j), compare Dagster
against Temporal as the orchestration engine.

## Two different problems in this system

1. **Indexing pipelines** (the original ask): extract data from a source,
   transform it, write it into a tenant's provisioned database, on a schedule
   or trigger. Track what has been indexed and what is stale, per tenant.

2. **DBaaS provisioning/reconciliation** (already sketched in
   `docs/discussion/database-as-a-service.md`): enqueue provisioning work,
   return immediately, have a worker wait for Kubernetes readiness, verify
   the deployment, mark ready/failed, run a reconciler that retries
   `provisioning`/`deleting` rows, take a final backup before delete.

These are different shapes of problem. (1) is asset/data-oriented. (2) is a
long-running, retry-heavy, signal-driven business process — the DBaaS doc
already independently reinvented an outbox/status-column pattern and a
reconciler loop, both of which a durable-execution engine provides natively.

## Dagster

Asset-oriented data orchestrator. Unit of work is a data asset (table, graph,
file) with declared lineage. Built for batch/incremental ELT: schedules,
partitions, backfills, an asset catalog UI showing freshness and lineage.

Fit for indexing pipelines:

- Native partitions map cleanly onto "one partition per tenant instance."
- Native backfills, schedules, sensors.
- Asset catalog answers "is tenant X's data stale?" for free.
- Python only.
- Local dev: `dagster dev`, single process, UI included.
- Multi-tenancy requires a sensor polling Postgres for tenant state and
  registering/removing dynamic partitions (poll-based, not push).

Fit for provisioning/reconciliation: weaker. Dagster ops are not designed for
long waits, external signals, or the retry/backoff sophistication a
provisioning state machine needs. You would be building a workflow engine
inside Dagster ops rather than using Dagster's actual strength.

## Temporal

Durable execution engine for arbitrary business processes. Unit of work is a
workflow function — ordinary code (loops, conditionals, sleeps, waits on
signals) that survives crashes and redeploys, with deterministic replay and
first-class per-activity retry policies.

Fit for provisioning/reconciliation: strong. A `ProvisionNeo4jInstance`
workflow is just `await activities.createHelmRelease()`,
`await activities.waitForReady()`, `await activities.verifyApocGds()`,
`await activities.markReady()` — each step durable, retryable, and
observable via full workflow history. Deletion is the same shape with a
final-backup step first. No outbox table or hand-rolled reconciler needed;
Temporal's server is the reconciler.

Fit for indexing pipelines: workable but not asset-native.

- One workflow execution per tenant (workflow ID = instance ID), started
  directly by the app the moment an instance goes `ready` — a real push via
  client call or signal, not a poll.
- Schedules and signals are first-class.
- Retries/backoff and heartbeating for long steps are more mature than
  Dagster's op retries.
- No lineage/freshness concept — "is tenant X's data stale" would need to be
  built by hand (e.g. a status column plus a query), not given by a catalog
  UI.
- No native backfill primitive — a backfill is a hand-written loop starting N
  workflow executions.
- Any of Go/Java/Python/TypeScript. Could stay in TypeScript, matching the
  existing Astro/TS control plane and avoiding a second language/toolchain in
  this repo.
- Local dev needs a Temporal server (`temporal server start-dev` or Temporal
  Cloud) plus a worker process — one more moving part than Dagster's
  single-process dev loop.

## Comparison

| | Dagster | Temporal |
|---|---|---|
| Language | Python only | Go/Java/Python/TypeScript |
| Monorepo shape | code location per pipeline type + shared core package | worker package per workflow domain + shared core package (structurally similar either way) |
| Multi-tenancy | dynamic partitions, sensor polls Postgres | one workflow execution per tenant, started by direct call/signal |
| Scheduling | schedules/sensors (cron + poll-based events) | Temporal Schedules (cron) or Signals (true push) |
| Retries | op-level retry policies | per-activity retry policies, backoff, heartbeating — more mature for long/flaky steps |
| Observability | asset catalog: lineage, freshness, materializations | workflow history: full deterministic replay, no data-asset concept |
| Backfills | native | hand-written |
| Local dev | `dagster dev`, single process | Temporal server + worker process |
| Mental model | "what data is fresh?" | "what long-running process is in flight, and does it survive a crash?" |

## Recommendation

Use each engine for the problem it is actually good at rather than picking
one for the whole system:

- **Dagster** for the indexing pipelines: extract/transform/load into
  provisioned databases, scheduled or triggered, with per-tenant partitions
  and an asset catalog for freshness.
- **Temporal** for the DBaaS provisioning/reconciliation lifecycle described
  in `docs/discussion/database-as-a-service.md`: create/wait/verify/ready,
  delete-with-final-backup, and the reconciler loop, all as durable
  workflows instead of a hand-rolled outbox table and polling reconciler.

If indexing work turns out to be dominated by long sequences of
side-effecting steps with waits and retries (call an external API, wait for
a job, poll for completion, handle partial failure) rather than classic
"recompute this table from that table" ELT, Temporal alone — in TypeScript,
one language for the whole repo — is a reasonable alternative to running
both engines. The tradeoff is losing the asset catalog's free answer to "is
this tenant's data stale," which would need to be hand-built as a status
column and query instead.

## Decision (2026-07-03)

Temporal, in TypeScript, for both problems — not split by engine. See
`docs/discussion/temporal-pipelines-plan.md` for the concrete scaffold:
Temporal server + UI added to `docker-compose.yml` reusing the existing
Postgres instance, and a `pipelines/` monorepo (`core` shared package plus
one workflow package per task queue: `dbaas-provisioning`,
`document-indexing`).

Rationale for one-engine-for-both over the Dagster/Temporal split floated
above: the near-term indexing pipeline (document upload -> extract entities
and relationships -> write to Neo4j) turned out to be a step-heavy,
side-effecting sequence rather than classic recompute-this-table ELT, which
is Temporal's strength rather than Dagster's. Running one engine also keeps
the whole repo in TypeScript instead of adding Python. The tradeoff called
out above still applies: there is no free asset/freshness catalog, so "is
this tenant's data indexed and up to date" will need to be tracked
explicitly (see the `document_indexing_runs`-shaped table sketched in the
plan doc).
