# Control Plane CLI (Go / Cobra)

Status: Discussion

Date: 2026-07-04

## Purpose

Give users a CLI, modeled on the [Claude Code CLI](https://platform.claude.com/docs/en/cli-sdks-libraries/cli/quickstart),
that can do everything the dashboard can do **except mint or manage API
keys**. Key lifecycle (create, rename, revoke) stays a dashboard-only,
session-authenticated operation. Everything else — provisioning a Neo4j
database, indexing a document, checking job status, reading usage — should
be reachable from a terminal, authenticated with an API key the user already
has.

This doc is a discussion/design doc, not an implementation plan. It records:
what the CLI needs to do, what the backend is missing to support it safely,
and the shape of the Go program itself.

## What "like the Claude Code CLI" means here

The Claude Code CLI quickstart is a useful reference point for the shape we
want, not the mechanics (that CLI drives an agent loop; ours drives CRUD
calls). The properties worth copying:

- **A single static binary**, installed with one command, no runtime
  dependency (no Python/Node required on the user's machine).
- **API key as the only credential**, read from an env var or a config
  file, never re-derived or minted by the CLI itself.
- **Thin client over a stable HTTP API** — the CLI has no business logic;
  every command is a REST call plus formatting.
- **Scriptable output** — human table output by default, `--output json`
  for piping into `jq`/CI.

## Current backend surface (as of this doc)

`src/pages/openapi.json.ts` is the source of truth for what exists today.
Two authentication mechanisms already coexist:

| Mechanism | Helper | Used by |
|---|---|---|
| Session cookie (`cp_session`, Google login) | `requireUser()` in `src/lib/responses.ts` | `/api/api-keys*`, `/api/neo4j*`, `/api/api-keys/{apiKeyId}/neo4j*`, `/api/usage`, `/api/billing*` |
| Bearer API key (`Authorization: Bearer cp_live_...`) | `authenticateApiKey()` in `src/lib/metering.ts` | `/api/usage/events`, `/api/mock/inference` |

The important, non-obvious fact: **every route the CLI actually needs
(provisioning, listing, deleting a Neo4j instance; starting/checking a
document-indexing job) is currently session-only.** Only the two metering/
mock endpoints accept a bearer key. Building the CLI against today's API as-
is would mean either (a) making the CLI do a Google OAuth device flow itself
(heavyweight, not what "paste your API key" implies), or (b) the CLI can
only ever call the two bearer-authenticated endpoints. Neither is the goal
stated above, so the backend needs new routes/auth wiring before the CLI is
useful for anything beyond usage events.

The other detail worth flagging: the existing DBaaS routes are shaped
`/api/api-keys/{apiKeyId}/neo4j/{instanceId}` — `apiKeyId` is a **path**
parameter, authorized by checking `user.id` (from the session) owns that
key. That's fine for a dashboard fetching its own data. It's the wrong shape
for a bearer-authenticated CLI: a request authenticated *by* an API key
should act *as* that key, not trust a second key ID supplied in the URL.
Concretely: if `authenticateApiKey()` returns `{ user_id, api_key_id }`,
routes for the CLI should scope by the `api_key_id` the bearer token
resolved to, not by an `apiKeyId` in the path — otherwise a leaked/former
key's ID in a URL becomes a lever to reference a different key's data (an
IDOR risk in the CLI-facing surface even if the dashboard's own use of the
route is safe today).

## Does this mean refactoring the existing dashboard routes?

No. It's worth being precise about what's actually wrong, because two
different concerns were initially conflated:

- The `apiKeyId` in today's dashboard routes (e.g.
  `/api/api-keys/{apiKeyId}/neo4j`) is the **database row UUID**
  (`api_keys.id`), not the plaintext secret token. The secret
  (`cp_live_xxx_secret`) is shown once at creation and never stored or
  echoed back (`apiKeys.ts` only persists `key_hash`). So this is not a
  "credential in the URL" problem in the way a session token or password
  in a query string would be — it's a resource identifier, comparable to
  `/users/{userId}/orders/{orderId}`. Every route also re-checks
  `where id = $1 and user_id = $2` against the session-derived user, so
  ownership is enforced server-side no matter what a client puts in the
  path. **The dashboard's existing routes don't need to change.**

- The real issue only shows up once bearer auth enters the picture: a
  bearer token *is* the proof of "which key is acting." If a
  bearer-authenticated route also accepted an `apiKeyId` from the path or
  body, there'd be two competing sources of truth for identity — a
  confused-deputy shape, not a secrecy leak. The fix is simply that
  bearer-authenticated routes never take an `apiKeyId` parameter at all;
  it's derived from the token.

Given that, the plan is additive, not a migration: leave `/api/*`
(session-cookie, dashboard BFF) exactly as-is, and add `/api/v1/*`
(bearer-scoped) alongside it. This isn't "maintaining two API versions" in
the costly sense — both surfaces call the same shared functions in
`lib/dbaas/neo4j.ts` and `lib/pipelines/documentIndexing.ts`; only the thin
auth/param-extraction wrapper per route differs. There's also a structural
reason the dashboard can't simply move to bearer auth even if we wanted
one surface: the browser never holds the plaintext key after the
one-time reveal at creation, so it has nothing to send as a `Bearer`
header — session cookies are the only auth mechanism available to it.

**Decision: `/api/v1` is the general public API, not a CLI-only side
channel.** The CLI is its first consumer, but the surface should be
documented and held to a real stability bar (additive changes only,
deprecation windows before removing a field/route) from the start, since
building it as "CLI-internal" now and promoting it to public later would
mean a second migration. This resolves the last open question below.

## Proposed backend changes

1. **Introduce a versioned, key-scoped API surface**: `/api/v1/*`, separate
   from the existing `/api/*` dashboard BFF routes. `/api/*` keeps serving
   the dashboard (session cookies, `apiKeyId` in the path is fine there
   because the dashboard is Browse-as-a-user, not act-as-a-key). `/api/v1/*`
   is bearer-only and every route acts as the authenticated key — no
   `apiKeyId` path segment, ever.

   ```
   GET    /api/v1/me                          -> { user_id, api_key_id, key_prefix, name }
   GET    /api/v1/databases                   -> list Neo4j instances for this key
   POST   /api/v1/databases                   -> provision one (mirrors existing free-tier logic)
   GET    /api/v1/databases/{instanceId}      -> get one
   DELETE /api/v1/databases/{instanceId}      -> delete one
   POST   /api/v1/databases/{instanceId}/documents          -> start an indexing job
   GET    /api/v1/databases/{instanceId}/documents          -> list jobs
   GET    /api/v1/databases/{instanceId}/documents/{jobId}  -> job status
   GET    /api/v1/usage                       -> usage summary scoped to this key
   POST   /api/v1/usage/events                -> already bearer-authenticated; just move/alias under v1
   ```

2. **Extract a `requireApiKey()` helper** parallel to `requireUser()`, in
   the same style as `src/lib/responses.ts`, built on the existing
   `readBearerToken()` / `authenticateApiKey()` in `src/lib/metering.ts`.
   Every `/api/v1/*` route calls this instead of `requireUser()`, and
   downstream calls to `dbaas/neo4j.ts` / `pipelines/documentIndexing.ts`
   take `apiKeyId` from the authenticated token, never from the URL or body.

3. **`getNeo4jInstanceForUser`, `getNeo4jInstance`, `listNeo4jInstances`,
   `createNeo4jInstance`, `deleteNeo4jInstance`** in `src/lib/dbaas/neo4j.ts`
   already take `(userId, apiKeyId, ...)` — the v1 routes can call these
   directly with the resolved `api_key_id`/`user_id` from
   `authenticateApiKey()`, no signature changes needed. Same for
   `startDocumentIndexingJob` / `listDocumentIndexingJobs` /
   `getDocumentIndexingJob` in `src/lib/pipelines/documentIndexing.ts`,
   which already take `apiKeyId`.

4. **`Idempotency-Key`** is already a first-class concept for
   `/api/usage/events` (`readIdempotencyKey`). The CLI should send it on
   `POST /api/v1/databases` and `POST /api/v1/databases/{id}/documents`
   too, since both are the kind of call a user re-runs after a network
   blip and neither should double-provision or double-index. That likely
   means adding idempotency-key support to `createNeo4jInstance` and
   `startDocumentIndexingJob`, which don't have it today — worth a
   dedicated follow-up doc if we want it, not a blocker for a first CLI cut
   (the routes already return the existing instance/job with 200 semantics
   in some paths; check case-by-case before assuming it's needed).

5. **Rate limiting / abuse**: bearer-authenticated provisioning is a new
   attack surface (a leaked key can now spin up databases from any
   machine, not just via the browser session that minted it). Whatever
   the free-tier instance-limit check does today (`409` in the OpenAPI
   spec) is the right control to lean on; no new mechanism needed, just
   confirm it's enforced per-key regardless of caller.

6. **Key management stays out of `/api/v1`.** No `POST /api/v1/api-keys`.
   The CLI can have a `cp auth status` command that calls `GET /api/v1/me`
   to confirm the key it's holding is valid, but creating/revoking keys is
   dashboard-only, by design, per the original ask.

## CLI shape

### Config & auth

- Env var `CP_API_KEY` takes precedence (CI-friendly, matches the
  `ANTHROPIC_API_KEY`-style convention).
- Falls back to a config file, `~/.config/cp/config.toml` (XDG on
  Linux/macOS), written by `cp auth login --key cp_live_...` or piped via
  stdin (`cp auth login` prompts, doesn't echo).
- `CP_API_URL` / a `--api-url` flag for pointing at a non-default control
  plane (self-hosted, staging), defaulting to the production origin.
- Config file permissions forced to `0600` on write.
- No OS keychain integration in v1 — plain file is consistent with `~/.aws/credentials`-style tools and keeps the Go dependency graph small. Revisit if users ask for it.

### Command tree

```
cp
├── auth
│   ├── login       # store an existing API key (from env, flag, or prompt)
│   ├── logout      # remove the stored key
│   └── status      # GET /api/v1/me — confirm the key is valid, show owner/prefix
├── db
│   ├── create [--name NAME] [--wait]   # POST /api/v1/databases (async by default)
│   ├── list                            # GET  /api/v1/databases
│   ├── get <instance-id>               # GET  /api/v1/databases/{id}
│   └── rm <instance-id>                # DELETE /api/v1/databases/{id}
├── docs
│   ├── index <instance-id> [--file PATH | --stdin] [--wait]   # POST /api/v1/databases/{id}/documents (async by default)
│   ├── list <instance-id>                                     # GET  /api/v1/databases/{id}/documents
│   └── status <instance-id> <job-id>                          # GET  .../documents/{jobId}
├── usage
│   └── show                        # GET /api/v1/usage
└── version
```

Global flags: `--output table|json` (default `table`), `--api-url`,
`--quiet`. Every command that mutates state (`db create`, `db rm`,
`docs index`) prints the created/deleted resource ID on success so it's
pipeable (`id=$(cp db create --output json | jq -r .instance.id)`).

### Project layout (Cobra convention)

```
cmd/cp/main.go              # entrypoint, calls cmd.Execute()
cmd/cp/root.go              # root command, persistent flags, config load
cmd/cp/auth.go
cmd/cp/db.go
cmd/cp/docs.go
cmd/cp/usage.go
internal/client/client.go   # thin REST client: bearer header, base URL, retries
internal/client/databases.go
internal/client/documents.go
internal/client/usage.go
internal/config/config.go   # read/write ~/.config/cp/config.toml
internal/output/table.go    # table vs JSON rendering
```

`internal/client` is generated or hand-written directly from
`/api/v1/openapi.json` (extend the existing `openapi.json.ts` generator to
emit the v1 paths) so the CLI and the API can't silently drift — worth
comparing `oapi-codegen` against hand-written client at implementation
time, but that's an implementation detail, not a design blocker.

### Distribution

- `goreleaser` producing binaries for `darwin/{amd64,arm64}`,
  `linux/{amd64,arm64}`, attached to GitHub Releases.
- Install script (`curl -fsSL .../install.sh | sh`) mirroring the Claude
  Code quickstart's one-liner, or a Homebrew tap if the user base is
  mac-heavy — either is fine, not a blocking decision for this doc.

## Resolved decisions

- **`cp db create` is asynchronous by default.** It returns as soon as the
  API responds (matching the existing `201`/instance-ready or
  `202`/still-provisioning shape), printing the instance ID and status
  immediately rather than blocking. `--wait` is an opt-in flag that polls
  `GET /api/v1/databases/{id}` until the instance reaches `ready` (or a
  terminal failure state) before returning. Default-async keeps the
  command fast and composable (scriptable, pipeable); `--wait` covers the
  interactive "I just want to see it finish" case.
- **`cp docs index` is asynchronous by default**, for the same reason and
  more emphatically so: indexing is the more expensive, more
  variable-duration operation of the two, and a default-blocking command
  would make simple scripts (e.g. indexing a batch of documents in a loop)
  needlessly slow. It returns the `jobId` immediately (matches today's
  `202` from `POST .../documents`); `cp docs status <instance-id> <job-id>`
  polls explicitly, and `--wait` on `docs index` is the same opt-in
  convenience wrapper around that polling loop.
- **`/api/v1` is the official public API**, not CLI-internal — see
  "Does this mean refactoring the existing dashboard routes?" above.
