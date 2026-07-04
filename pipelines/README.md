# Pipelines (Temporal, TypeScript)

Monorepo for durable workflows that back the control plane: database
provisioning/reconciliation and document indexing into provisioned
databases. See `docs/discussion/pipeline-orchestration-choice.md` and
`docs/discussion/temporal-pipelines-plan.md` for the reasoning behind
Temporal over Dagster, the end-to-end flow this supports, and the
job-tracking and worker-bootstrap abstractions in `core`.

## Layout

```text
pipelines/
  core/                          # @pipelines/core
    src/
      clients/                     # Temporal client, read-only control-plane
                                     # Postgres access, Neo4j driver factory,
                                     # pipeline_jobs raw SQL
      activities/jobActivities.ts    # Temporal activities backing job tracking
      workflow/                       # @pipelines/core/workflow (sandbox-safe)
        withJobTracking.ts              # wraps a workflow entry point with
                                           # queued -> running -> succeeded/failed
        reportProgress                    # per-step progress from inside a workflow
      worker/                           # @pipelines/core/worker (Node-side)
        startPipelineWorker.ts             # connect + merge jobActivities + run

  workflows/
    dbaas-provisioning/           # create/wait/verify/ready, delete+backup,
                                    # one workflow execution per instance
    document-indexing/            # two workflows, one worker:
      src/
        documentIndexingWorkflow.ts  # IndexDocumentWorkflow: fetch -> extract
                                        # (GPT-4o-mini) -> write to Neo4j -> record
        normalizeEntitiesWorkflow.ts    # NormalizeEntitiesWorkflow: one sweep,
                                          # run every 10 min by a Temporal Schedule
                                          # (normalize-<instanceId>), not a sleep-loop
        scheduleActivities.ts              # ensureNormalizationScheduleExists —
                                              # creates that Schedule lazily, idempotent
        activities.ts                        # document fetch/extract/write activities
        normalizationActivities.ts             # sweep's Neo4j queries, merge logic,
                                                  # and the sweep checkpoint (stored as a
                                                  # node in the instance's own graph)
        cypherUtil.ts                              # sanitizes LLM-produced Cypher labels
        workflows.ts                                 # barrel: both workflows, one entry point
```

Each package under `workflows/` is an independent Temporal worker process
with its own task queue. **Adding a pipeline never requires touching
`core/`** — a new package needs only:

```text
workflows/<name>/
  package.json      # deps: @pipelines/core (workspace), @temporalio/workflow
  tsconfig.json      # extends ../../tsconfig.base.json, references ../../core
  src/
    activities.ts      # plain async functions — the real side effects
    workflows.ts        # proxyActivities + withJobTracking("Name", fn) + reportProgress(...)
    worker.ts             # ~7 lines calling startPipelineWorker
    starter.ts               # optional manual-test script calling startTrackedWorkflow
```

## Local setup

```sh
# 1. Start Postgres + Temporal server + Temporal UI (http://localhost:8088)
just temporal

# 2. Install pipeline dependencies
just pipelines-install

# 3. Run a worker (repeat in another terminal for the other workflow package)
just pipelines-worker-dbaas
just pipelines-worker-docs
```

Copy `.env.example` to `.env` and fill in `CONTROL_PLANE_DATABASE_URL`,
`KUBECONFIG`, and `OPENAI_API_KEY` (used by document-indexing's extraction
and normalization-sweep LLM calls).

## Status

Job tracking (`pipeline_jobs`, `startTrackedWorkflow`, `withJobTracking`,
`reportProgress`), the worker bootstrap (`startPipelineWorker`), and
document-indexing's GPT-4o-mini entity/relationship extraction plus its
sweep-normalization workflow are real and verified against a live local
Temporal + Postgres deployment (including an actual OpenAI call). Still
`TODO`-stubbed: Helm/kubectl in dbaas-provisioning, the Kubernetes Secret
read in `@pipelines/core`'s Neo4j client (so any activity that actually
writes to Neo4j fails until that's implemented), Google Docs export, and
the `document_indexing_runs` table `recordIndexingResult` needs.
