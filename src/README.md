# Web console (Astro)

The dashboard: Google login, API key management, Neo4j database
provisioning/deletion, document indexing, usage, and billing. Also serves
the `/api/v1/*` bearer-authenticated surface the CLI and any other API
client use — see [`../cli/README.md`](../cli/README.md) and
[`../docs/discussion/cli-tool.md`](../docs/discussion/cli-tool.md) for why
that surface exists separately from the dashboard's own routes.

Server-rendered with Astro (`output: "server"`, `@astrojs/node` adapter,
standalone mode) — a normal long-lived Node process, not a serverless
function per request. That matters for `src/lib/dbaas/neo4j.ts`: database
creation kicks off Kubernetes provisioning in the background after
responding, which only works because the process keeps running afterward.

## Two authentication models, on purpose

| | Session cookie | Bearer API key |
|---|---|---|
| Proves | which **user** is asking | which **API key** is asking |
| Helper | `requireUser()` (`lib/responses.ts`) | `requireApiKey()` (`lib/responses.ts`) |
| Routes | `/api/*` (except `usage/events`, `mock/*`) | `/api/v1/*`, `/api/usage/events`, `/api/mock/*` |
| Used by | the dashboard's own `fetch` calls | the CLI, or any other API client |

The `/api/*` routes take an `apiKeyId` as a **path parameter** — that's
fine there, because the caller is proven to be a user browsing (possibly
several of) their own keys' data, and every handler re-checks
`where user_id = $current_user`. The `/api/v1/*` routes never take an
`apiKeyId` param anywhere — the bearer token itself resolves to exactly
one `api_key_id`/`user_id` pair server-side (`authenticateApiKey()` in
`lib/metering.ts`), and every downstream call is scoped by that. Mixing
the two (accepting a path `apiKeyId` on a bearer-authenticated route)
would let the token's identity and the URL's claimed identity disagree —
see `docs/discussion/cli-tool.md` for the full reasoning.

## Layout

```text
src/
  pages/
    index.astro                  # dashboard shell (renders DashboardApp.tsx)
    docs.astro                   # renders the OpenAPI spec (openapi.json.ts) as docs
    databases/[instanceId].astro # per-database detail page (renders DatabaseDetail.tsx)
    openapi.json.ts              # hand-written OpenAPI 3.1 spec for /api/* (not /api/v1 yet)

    api/                         # session-cookie routes — the dashboard's own backend
      auth/{google,logout}.ts      # Google ID token -> session cookie
      me.ts                          # current user from session
      api-keys/{index,[id]}.ts         # list/mint/rename/revoke — key lifecycle lives ONLY here
      api-keys/[apiKeyId]/neo4j/*         # provision/list/get/delete, scoped by path apiKeyId
      neo4j/[instanceId]*                   # instance + document-indexing routes, user-scoped
      usage/{index,events.ts}                 # events.ts is bearer-authenticated (see below)
      billing/*                                  # Stripe checkout/portal/status
      webhooks/stripe.ts                            # Stripe webhook receiver
      mock/inference.ts                                # bearer-authenticated demo metered endpoint

    api/v1/                      # bearer-only, no apiKeyId param anywhere — the CLI's backend
      me.ts                        # who does this token resolve to
      databases/{index,[instanceId]}.ts       # list/create/get/delete
      databases/[instanceId]/documents/*         # start/list/get indexing jobs
      usage/{index,events.ts}                       # summary, + idempotent event recording

  lib/
    db.ts               # pg Pool + drizzle handle + query(); ensureSchema() lazily
                           # creates/migrates tables on first query (see root README)
    auth.ts              # Google ID token verification, session cookie mint/read/revoke
    apiKeys.ts             # mint/list/rename/revoke API keys, usage summaries
    metering.ts             # bearer token parsing + hashing + lookup (authenticateApiKey),
                              # idempotent usage-event recording
    responses.ts              # json(), requireUser(), requireApiKey(), readJson() —
                                 # every route handler is built on these
    crypto.ts                    # hashApiKey/hashSessionToken (peppered/HMAC'd), randomToken
    dbaas/
      neo4j.ts                     # Neo4j instance lifecycle: insert row, provision
                                      # (sync for the dashboard, async-backgrounded for
                                      # /api/v1 — see createNeo4jInstance vs
                                      # createNeo4jInstanceAsync), delete. Per-instance
                                      # in-process lock so delete can't race a still-running
                                      # background provision (see withInstanceLock)
      kubernetes.ts                   # the actual helm/kubectl/docker calls: install,
                                         # wait-for-ready, external Bolt/Browser exposure via
                                         # ingress-nginx TCP passthrough + nip.io, teardown
    pipelines/
      documentIndexing.ts            # minimal Temporal client: start/list/get
                                        # IndexDocumentWorkflow executions + pipeline_jobs
                                        # rows. Deliberately not a dependency on
                                        # pipelines/core (see file header comment) — the
                                        # pipelines/ monorepo is a separate npm project
    billing/index.ts                 # Stripe subscription + metered billing sync

  components/            # React islands rendered into the Astro pages
    DashboardApp.tsx        # API keys, per-key database list, create/delete
    DatabaseDetail.tsx        # one database: connection info, document indexing UI,
                                # polls job status every 2s while any job is in flight
    StatusPill.tsx              # status-to-color badge, shared by both

  db/schema.ts            # drizzle-orm table definitions (source of truth for
                             # `npm run db:generate`); `lib/db.ts`'s ensureSchema() is a
                             # separate, hand-written `create table if not exists` path
                             # used for fast local iteration — keep both in sync by hand
```

## Request flow for the two "slow" operations

Both of these used to block the HTTP response for the full duration of the
underlying work; both now return once the row exists and finish the slow
part afterward — the dashboard's UI already expected a `provisioning`/
in-flight state and (for jobs) already polls, so the async CLI-facing path
in `createNeo4jInstanceAsync` didn't require a UI change.

- **Provision a database**: insert `neo4j_instances` row (`status:
  'provisioning'`) → [dashboard: await; CLI: return now] → helm
  install/wait/verify in `lib/dbaas/kubernetes.ts` → row updated to
  `ready`/`failed`.
- **Index a document**: insert `pipeline_jobs` row (`status: 'queued'`) →
  start `IndexDocumentWorkflow` on Temporal, return the job ID → the
  `document-indexing` pipeline worker (see `pipelines/README.md`) takes it
  from there, updating the same row as it progresses.

## Local dev

See the root [`README.md`](../README.md) for the full setup order. Once
Postgres (and, if you need real provisioning, kind) are up:

```sh
npm install
npm run dev -- --host 127.0.0.1   # or: just web
```

`npm run build` runs `astro check` (typecheck) then `astro build`. There's
no separate lint/test-only typecheck command — `astro check` is also what
CI-equivalent validation should run.
