# Temporal Pipelines: Docker Compose + Monorepo Scaffold

Status: Implemented (scaffold only, activities are stubs)

Date: 2026-07-03

## Purpose

Follow-up to `docs/discussion/pipeline-orchestration-choice.md`. That doc
concluded Temporal, in TypeScript, should back both the DBaaS
provisioning/reconciliation lifecycle and the document-indexing flow. This
doc records what was built: the Temporal server in `docker-compose.yml` and
the `pipelines/` monorepo.

## End-to-end flow this supports

```text
1. User clicks "create database" in the dashboard.
2. API inserts neo4j_instances(status = 'provisioning') and starts
   ProvisionNeo4jInstanceWorkflow (task queue: dbaas-provisioning).
   Workflow: createHelmRelease -> waitForStatefulSetReady ->
   verifyApocAndGds -> markReady. Any step failing marks the row 'failed'
   with the error, instead of leaving it ambiguous.
3. Once ready, the user uploads a document (a markdown file, or a Google
   Doc export) against that instance.
4. Upload endpoint starts IndexDocumentWorkflow (task queue:
   document-indexing), workflow ID derived from the upload id so a retried
   request doesn't start a duplicate run.
   Workflow: fetchDocumentText -> extractEntitiesAndRelationships ->
   writeGraphToInstance -> recordIndexingResult.
5. Later, deleting the database starts DeleteNeo4jInstanceWorkflow:
   markDeleting -> takeFinalBackup -> uninstallHelmRelease ->
   deleteSecretAndPvc -> markDeleted.
```

Each arrow is a Temporal activity with its own retry policy; the workflow
function itself is just the sequence, and Temporal makes each step durable
across worker restarts/crashes.

## Docker Compose

Added to the existing `docker-compose.yml`, reusing the current
`control-plane-postgres` container rather than standing up a second
Postgres:

- `temporal` — `temporalio/auto-setup`, which creates its own `temporal` and
  `temporal_visibility` databases in that same Postgres instance on first
  boot (separate from `control_plane`, no schema collision). Frontend on
  `7233`.
- `temporal-admin-tools` — `tctl`/`temporal` CLI container for ad-hoc
  namespace/workflow inspection.
- `temporal-ui` — web UI on `8080` (http://localhost:8080).

Run with `just temporal` (`docker compose up -d postgres temporal
temporal-ui`).

### Retention

`DEFAULT_NAMESPACE_RETENTION=720h` (30 days) is set on the `temporal`
service so completed workflow history — provisioning runs, indexing runs —
is queryable in the UI for 30 days before Temporal deletes it.

This variable only takes effect when auto-setup **creates** the namespace.
If the `default` namespace already exists from an earlier run before this
was added, update it directly instead of relying on the env var:

```sh
docker compose exec temporal-admin-tools \
  temporal operator namespace update --retention 720h default
```

## `pipelines/` monorepo

```text
pipelines/
  package.json              # npm workspaces root: core, workflows/*
  tsconfig.base.json
  .env.example

  core/                      # @pipelines/core
    src/
      config.ts               # env config (TEMPORAL_ADDRESS, namespace, DB url)
      clients/
        temporalClient.ts      # shared Client for starting workflows
        controlPlaneDb.ts       # read-only pg access to neo4j_instances
        neo4j.ts                 # Neo4j driver factory (resolves creds via k8s Secret)

  workflows/
    dbaas-provisioning/        # @pipelines/dbaas-provisioning
      src/
        workflows.ts            # ProvisionNeo4jInstanceWorkflow, DeleteNeo4jInstanceWorkflow
        activities.ts           # Helm/kubectl/Postgres status-update stubs
        worker.ts                # Worker on task queue "dbaas-provisioning"
        starter.ts                # manual-test script to start a workflow

    document-indexing/         # @pipelines/document-indexing
      src/
        workflows.ts            # IndexDocumentWorkflow
        activities.ts           # fetch doc text, extract graph, write to Neo4j, record result
        worker.ts                # Worker on task queue "document-indexing"
        starter.ts                # manual-test script (markdown file -> workflow)
```

Each workflow package is an independent npm workspace with its own Temporal
worker and task queue, depending on `@pipelines/core` via the workspace
link. Adding a new pipeline means adding a new package under `workflows/`,
not modifying an existing one — same isolation goal the earlier
multi-code-location Dagster sketch had, just expressed as npm workspaces
instead of Dagster code locations.

`core`'s Postgres access is read-only by convention (`getReadyNeo4jInstance`
only selects); the activities that need to write control-plane state
(`markReady`, `markFailed`, `markDeleted`, ...) are defined per workflow
package, not in `core`, so it's obvious from the package boundary which
writes exist and where.

## What's stubbed vs. real

Real: package/workspace wiring, task queues, workflow step sequencing,
retry policies, the Temporal client/worker bootstrap, the read-only
Postgres query against the real `neo4j_instances` schema.

Stubbed (throws a `TODO` error naming exactly what needs to be implemented):
Helm/kubectl calls, Kubernetes Secret reads, the entity/relationship
extraction call (likely an LLM), the Google Docs export call, and the
`document_indexing_runs`-shaped write that `recordIndexingResult` needs — no
such table exists yet in `src/db/schema.ts`.

## Job tracking (core capability, 2026-07-03)

Every pipeline needs the same thing: an API call that returns a job ID
immediately, and a way to poll that job ID for status while Temporal does
the work. Rather than each workflow package reimplementing this, it lives
in `@pipelines/core` and is split three ways, because Temporal workflow
code runs in a deterministic sandbox and can't safely do I/O itself:

```text
core/src/
  clients/jobsDb.ts        # raw SQL against pipeline_jobs (Node-side)
  activities/jobActivities.ts  # Temporal activities wrapping jobsDb (Node-side)
  workflow/withJobTracking.ts  # sandbox-safe decorator + reportProgress()
  client/startTrackedWorkflow.ts  # inserts the job row + starts the workflow
```

- **`pipeline_jobs`** — new table in the shared `control_plane` Postgres
  database (added to `src/db/schema.ts`, applied via `db:push` since this
  repo's local workflow doesn't use the migration journal — see the
  caveat below). Columns: `id` (== the Temporal workflow ID), `workflow_type`,
  `task_queue`, `status` (`queued`/`running`/`succeeded`/`failed`),
  `current_step`, `progress` (jsonb, one key per step), `input`, `result`,
  `error`, timestamps.
- **`startTrackedWorkflow(...)`** — the one function an API route calls:
  inserts the job row (`status = 'queued'`), starts the workflow with that
  same ID, returns `{ jobId }`. This is exactly "user uploads a document,
  gets a job ID back."
- **`withJobTracking(name, workflowFn)`** — wraps a workflow's entry point
  so it automatically marks the job `running` on start and
  `succeeded`/`failed` on completion, without each workflow author writing
  that try/catch by hand. `name` must match the exported const's name — the
  wrapped function is otherwise anonymous (it's the return value of a call,
  not a bare `const x = () => {}`), and `client.workflow.start` needs
  `fn.name` to know which workflow type to ask the server for.
- **`reportProgress(step, detail?)`** — called between activity steps
  inside a tracked workflow body for finer-grained progress than the
  overall lifecycle (e.g. `"creating-helm-release"`,
  `"waiting-for-statefulset-ready"`). Reads the job ID from the current
  workflow's execution context, so callers never thread it through by hand.
- **`getJobStatus(jobId)`** — re-exported for a future `GET /jobs/:jobId`
  Astro route.

Both `ProvisionNeo4jInstanceWorkflow`/`DeleteNeo4jInstanceWorkflow` and
`IndexDocumentWorkflow` now use this — adding a third pipeline means
wrapping its entry point in `withJobTracking` and spreading
`jobActivities` into its worker's `activities` map, nothing more.

### Verified locally

Ran the real worker against the real (dockerized) Temporal server and
Postgres, started `ProvisionNeo4jInstanceWorkflow` via
`startTrackedWorkflow`, and watched `pipeline_jobs` transition
`queued -> running -> failed` (failed because `createHelmRelease` is still
a `TODO` stub — that's the correct outcome; it proves the tracker, not
Helm) with `current_step` and `progress` populated along the way. Cross-checked
against `temporal workflow describe`, which agreed on workflow type,
start/close time.

### Caveats found while building this

- **`db:push` vs `db:migrate`**: `drizzle-kit generate` currently fails —
  `drizzle/meta/0005_snapshot.json` and `0006_snapshot.json` collide (same
  `id`), and there's no `0007_snapshot.json` for the already-applied
  `neo4j_instances` migration. This predates this change (likely from
  hand-writing `0007_add_neo4j_instances.sql` without running
  `db:generate`). `pipeline_jobs` was applied with `db:push --force`
  instead, matching how `neo4j_instances` actually got into the local
  database (there's no `drizzle.__drizzle_migrations` tracking table
  either). Fixing the snapshot chain is a separate task from this one.
- **`pg` (Postgres client library) vs `@types/pg`**: no issue hit, just
  noting `core` depends on both directly rather than importing the app's
  drizzle schema, so `pipelines/` has no compile-time dependency on `src/`.
- **`WorkflowStartOptions<T>` generic conditional type**: TypeScript can't
  structurally verify `{ args: Parameters<T> }` against `T`'s
  conditional-tuple check while `T` is still an open generic at the
  `startTrackedWorkflow` call site — a real TS limitation with conditional
  types over generics, not a type-safety hole in practice. Worked around
  with a documented `as unknown as WorkflowStartOptions<T>` cast at that one
  call site.
- **`moduleResolution`**: had to use `"node"` (not `"bundler"`, which
  requires an ESM-flavored `module` setting incompatible with the
  CommonJS output Temporal's workflow bundler expects) plus an explicit
  `paths` entry for the `@pipelines/core/workflow` subpath export, since
  classic Node resolution doesn't consult `package.json` `exports` for
  type-checking (Node's runtime resolver does, so this only affected
  `tsc`, not running via `tsx`).
- **`import.meta.url` doesn't work with CommonJS output** — each worker's
  `workflowsPath` uses `require.resolve("./workflows")` instead.

## Worker bootstrap abstraction (2026-07-03)

With a second real pipeline (`document-indexing`) alongside the first
(`dbaas-provisioning`), the per-package `worker.ts` files were near-identical
boilerplate: connect to Temporal, merge in `jobActivities`, create a
`Worker`, run it, exit on failure. That's now `startPipelineWorker` in
`@pipelines/core/worker`, mirroring how `withJobTracking`/`reportProgress`
already abstracted the workflow-side boilerplate. A pipeline package's
`worker.ts` is now:

```ts
import { startPipelineWorker } from "@pipelines/core/worker";
import * as activities from "./activities.js";

void startPipelineWorker({
  taskQueue: "my-new-pipeline",
  workflowsPath: require.resolve("./workflows"),
  activities,
});
```

Kept as a function each package calls (not a shared multi-pipeline
entrypoint or a base class) so pipelines stay one Temporal Worker process
each — independent scaling, and one pipeline's bad activity can't take down
another's worker poller. A registry-based single-process model was
considered and rejected: it would need a one-line edit in a shared registry
file every time a pipeline is added, which is exactly the "touching core to
add a pipeline" this is meant to avoid.

Progress reporting stays explicit (`reportProgress('step-name')` calls in
the workflow body) rather than auto-instrumenting every activity call via a
Temporal interceptor — explicit step names are human-readable
("waiting-for-statefulset-ready") where activity function names read as
implementation detail, and explicit calls make it easy to skip
noisy/uninteresting steps or attach extra detail (e.g. node/relationship
counts) at exactly the point that matters.

### What a new pipeline actually needs (zero changes to `core`)

```text
workflows/<name>/
  package.json      # deps: @pipelines/core (workspace), @temporalio/workflow
  tsconfig.json      # extends ../../tsconfig.base.json, references ../../core
  src/
    activities.ts      # plain async functions — the real side effects
    workflows.ts        # proxyActivities + withJobTracking("Name", ...) + reportProgress(...)
    worker.ts             # ~7 lines calling startPipelineWorker
    starter.ts               # optional manual-test script calling startTrackedWorkflow
```

Nothing under `core/` is touched. Verified this is still true after the
refactor: rebuilt the whole workspace (`tsc -b core workflows/dbaas-provisioning
workflows/document-indexing`), reset the test job row, restarted the
`dbaas-provisioning` worker (now built on `startPipelineWorker`), and reran
the same `queued -> running` check — unchanged behavior.

## Entity extraction and sweep normalization (2026-07-04)

The full flow requested: user uploads a document against a ready database
-> `IndexDocumentWorkflow` extracts entities/relationships with an LLM and
writes them to that instance's Neo4j -> a separate, long-running sweep
workflow periodically normalizes near-duplicate entities. Two workflows,
one worker, per the "multiple different workflows inside one worker"
request — both live in `workflows/document-indexing` and run on the same
`document-indexing` task queue.

### Extraction: real GPT-4o-mini call

`extractEntitiesAndRelationships` (in `activities.ts`) is no longer a
`TODO` stub — it calls OpenAI's `gpt-4o-mini` with strict JSON-schema
structured output (`response_format: { type: "json_schema", strict: true }`)
so the model's response is guaranteed to match `ExtractedGraph`'s shape
without a hand-written parser. The OpenAI client itself lives in
`@pipelines/core` (`getOpenAIClient()`, reading `OPENAI_API_KEY`) since any
future pipeline that needs an LLM call reuses it rather than each package
constructing its own client.

`ExtractedNode` gained a required `name` field (separate from the label) —
the normalization sweep below compares nodes by name similarity, so a
canonical display name has to exist to compare against. `writeGraphToInstance`
stamps `createdAt` via `ON CREATE SET` (not on every `MERGE` match) so the
sweep can tell genuinely new nodes from re-touched existing ones.

**Security note**: Neo4j labels and relationship types can't be passed as
query parameters — Cypher requires them inline in the query text — and
since they now come from LLM output rather than fixed application code,
that's a real (if narrow) injection surface. Added `toCypherIdentifier()`
(`cypherUtil.ts`) to sanitize to `[A-Za-z0-9_]` before interpolation.

### Sweep normalization: a Temporal Schedule, not a sleep-loop

`NormalizeEntitiesWorkflow` (`normalizeEntitiesWorkflow.ts`) originally
shipped as one long-running execution per instance that slept 10 minutes
and looped forever via `continueAsNew`. Switched to a **Temporal Schedule**
(`normalize-<instanceId>`, `spec.intervals: [{ every: "10 minutes" }]`)
instead, on the reasoning that recurrence is exactly what Schedules are
built for, and the sleep-loop's main advantage — carrying `lastSweepAt`
forward for free as `continueAsNew` input — wasn't actually worth the
tradeoffs: an infinite workflow with no native pause/resume or
next-run-time visibility, versus Temporal's Schedules tab giving that for
free. The workflow itself now runs once per invocation and checks whether
any node was created since the last sweep (`hasNewNodesSince`), only
paying for the expensive comparison/merge work if so — "if no new node is
created within the interval, don't normalize" is now just an early
`return`, not a loop iteration that skips work.

The one real cost of switching: each scheduled run is a **fresh workflow
execution**, so `lastSweepAt` can no longer ride along as workflow input.
It's read from and written back to a singleton `:_SweepCheckpoint` node in
the instance's own Neo4j graph instead (`getSweepCheckpoint`/
`setSweepCheckpoint` in `normalizationActivities.ts`) — chosen over adding
a new Postgres table since the checkpoint is inherently per-instance graph
state, not control-plane metadata.

It's still started lazily, just via a different mechanism: creating a
Schedule is a Temporal **client** operation, not something workflow code
can do directly (unlike `startChild`, which workflow code *can* call).
`ensureNormalizationScheduleExists` (`scheduleActivities.ts`) is therefore
an **activity** — it calls `@pipelines/core`'s `getTemporalClient()` and
`client.schedule.create(...)`, and every call after the first hits
`ScheduleAlreadyRunning`, which is swallowed. `IndexDocumentWorkflow` calls
this activity on every upload; only the first one for a given instance
actually creates anything. `NormalizeEntitiesWorkflow` is still **not**
wrapped in `withJobTracking` — `pipeline_jobs` models one bounded unit of
work with a terminal outcome, and a recurring sweep doesn't obviously map
to that (each run could arguably get its own job row, but that wasn't
asked for and would mean 144 rows/day/instance with no obvious consumer).

Merge decision is tiered, cheapest check first, per the multi-tier
similarity approach requested:

```text
score >= 0.95        -> merge automatically (heuristic alone is confident enough)
0.6 <= score < 0.95    -> ask GPT-4o-mini to judge; merge only if it agrees
score < 0.6              -> not a candidate, skip (bounds LLM calls to near-misses)
```

`score` is a normalized Levenshtein similarity over lowercased,
punctuation-stripped names (`normalizationActivities.ts`; no new
dependency — implemented directly, since this repo otherwise has no fuzzy-
matching library). Comparisons happen only within nodes sharing a label,
and only for labels that have at least one node created since the last
sweep — but against *all* nodes of that label, not just the new ones, so a
new node can be caught as a duplicate of one indexed long ago. Merging
itself uses `apoc.refactor.mergeNodes` (APOC is already part of the DBaaS
Helm setup) and stamps `normalizedAt`.

### Verified locally

Ran the real `document-indexing` worker (built with both workflows bundled
— confirmed via the webpack build log that only 3 `./src` modules were
pulled into the sandboxed bundle, nothing Node-only like `pg`/`openai`/
`@temporalio/client` leaked in) and started `IndexDocumentWorkflow` against
a real sample markdown document. Confirmed via `pipeline_jobs.progress`:
the extraction activity actually called OpenAI and returned a real graph
(`{"nodeCount": 5, "relationshipCount": 5}`) before failing at the
(pre-existing, unrelated) Neo4j-instance-lookup step.

After switching to Schedules: confirmed via `temporal schedule list` that
the upload created `normalize-test-instance-2` (action targeting
`NormalizeEntitiesWorkflow`, not paused, next run ~10 minutes out) rather
than starting a workflow directly. Used `temporal schedule trigger` to fire
it immediately rather than waiting, and confirmed via `temporal workflow
list` that this produced a **fresh workflow execution**
(`normalize-test-instance-2-workflow-<timestamp>`) — proof it's genuinely
Schedule-driven now, not a single continuously-running workflow. That run
failed at `getSweepCheckpoint`, the same pre-existing Neo4j
Kubernetes-secret TODO boundary everything else hits. Deleted the test
schedule and cleared test `pipeline_jobs` rows afterward.

### Next steps for this piece specifically

- `DeleteNeo4jInstanceWorkflow` (dbaas-provisioning) doesn't currently
  delete the matching `normalize-<instanceId>` Schedule when an instance is
  deleted — it'll keep firing (harmlessly, since `hasNewNodesSince` will
  just keep failing once the instance is gone) until manually deleted.
- No API route yet accepts a document upload and calls
  `startTrackedWorkflow(IndexDocumentWorkflow, ...)` — still only reachable
  via `starter.ts`.

## Next steps

1. Add a `document_indexing_runs` table (id, user_id, api_key_id,
   instance_id, source_type, status, error, created_at, updated_at) via
   drizzle, mirroring the `neo4j_instances` status-column pattern.
2. Implement the Kubernetes Secret read in `core/src/clients/neo4j.ts`,
   reusing the logic already in `src/lib/dbaas/kubernetes.ts`.
3. Implement the Helm/kubectl activities in
   `workflows/dbaas-provisioning/src/activities.ts`, replacing the
   request-time Helm CLI wrapper currently in `src/lib/dbaas/kubernetes.ts`.
4. Decide the extraction approach for `extractEntitiesAndRelationships`
   (LLM prompt vs. a deterministic NLP library) and implement it.
5. Add the upload API route and wire it to start `IndexDocumentWorkflow`
   via `@pipelines/core`'s `getTemporalClient()`.
6. Run `npm install` inside `pipelines/` to generate the lockfile (not run
   yet as part of scaffolding).
