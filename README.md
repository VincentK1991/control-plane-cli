# Control Plane

A Neo4j-database-as-a-service control plane: a web dashboard for managing
API keys and provisioned Neo4j databases, Temporal-backed pipelines that do
the actual provisioning/indexing work, and a Go CLI that talks to the same
bearer-scoped API the dashboard's backend exposes.

This README is the end-to-end setup runbook — the order below is the order
that actually works, since later steps depend on earlier ones (the web
console needs Postgres migrated; the CLI needs the web console running;
document indexing needs both Temporal and a provisioned database).

For deeper detail on each piece, see:

- [`src/README.md`](src/README.md) — the web console (Astro dashboard + API)
- [`pipelines/README.md`](pipelines/README.md) — Temporal workflows (provisioning, indexing)
- [`cli/README.md`](cli/README.md) — the `cp` Go CLI
- [`temporal/README.md`](temporal/README.md) — Temporal server config
- `docs/discussion/` — design docs behind each of the above (DBaaS architecture, pipeline orchestration choice, the CLI's `/api/v1` design, usage metering)

## Prerequisites

- Node.js 20+, npm
- Go 1.22+
- Docker Desktop (or equivalent) with `docker compose`
- `kind`, `kubectl`, `helm` (`brew install kind kubectl helm`)
- `just` (`brew install just`) — the repo's task runner; every command below has a matching Justfile target

## 1. Docker Compose: Postgres + Temporal

```sh
cp .env.example .env   # fill in GOOGLE_CLIENT_ID/PUBLIC_GOOGLE_CLIENT_ID, SESSION_SECRET,
                        # API_KEY_PEPPER (openssl rand -hex 32 for the two secrets)

just temporal           # docker compose up -d postgres temporal temporal-ui
```

This starts three containers: Postgres on `localhost:5433` (mapped from
5432 to stay out of the way of a system-wide Postgres), the Temporal
server on `localhost:7233`, and the Temporal Web UI at
`http://localhost:8088`. `just db` starts only Postgres if you don't need
Temporal yet.

Temporal's own schema lives in the same Postgres instance, in separate
`temporal`/`temporal_visibility` databases — no collision with the app's
`control_plane` database. See the comment in `docker-compose.yml` if the
Temporal container fails to boot on a fresh volume (it needs those two
databases provisioned once via `temporal-sql-tool` before first use).

## 2. Database: Postgres + Drizzle

```sh
npm install
npm run db:push      # or: npm run db:generate && npm run db:migrate
```

`db:push` is the fast local loop (applies the current `src/db/schema.ts`
directly, no migration file); `db:generate`/`db:migrate` is what committed
schema changes should use (writes a SQL file under `drizzle/`, matching
what's already in there). `npm run db:studio` opens Drizzle Studio against
the same database if you want to browse tables directly.

Note: the app also has a lazy `ensureSchema()` in `src/lib/db.ts` that
`create table if not exists`-es everything on first query — in practice
you can skip this step entirely for local dev and let the web console
create its own schema on first request. Use the explicit `db:push`/
`db:migrate` path when you want the schema to match a specific migration
file, e.g. before deploying.

## 3. Local Kubernetes (kind) — for DBaaS provisioning

Only needed if you want `db create`/provisioning to actually work end to
end (rather than fail with a `failed` status and a clear error). Skip this
section if you're only working on the dashboard UI, auth, or billing.

```sh
kind create cluster --name control-plane-dbaas
kubectl cluster-info --context kind-control-plane-dbaas

helm repo add neo4j https://helm.neo4j.com/neo4j
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update

# ingress-nginx as NodePort (kind has no cloud load balancer). The app
# manages per-instance Bolt TCP passthrough entries in the
# ingress-nginx-tcp ConfigMap itself at provision time — nothing else to
# configure here.
helm install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx --create-namespace \
  --set controller.service.type=NodePort \
  --set controller.service.nodePorts.http=30080 \
  --set controller.service.nodePorts.https=30443
```

kind's Docker container only publishes the Kubernetes API port to the
host — it does not publish arbitrary NodePorts. Bridge the ones you need
with `socat` containers on the `kind` Docker network (the kind node's
in-cluster IP, e.g. `172.18.0.2`, can be found with
`docker inspect <kind-node-container> --format '{{(index .NetworkSettings.Networks "kind").IPAddress}}'`):

```sh
docker run -d --name kind-proxy-http  --network kind --restart unless-stopped \
  -p 80:80   alpine/socat TCP-LISTEN:80,fork,reuseaddr   TCP:<kind-node-ip>:30080
docker run -d --name kind-proxy-https --network kind --restart unless-stopped \
  -p 443:443 alpine/socat TCP-LISTEN:443,fork,reuseaddr TCP:<kind-node-ip>:30443
```

Per-instance Bolt proxies (`kind-proxy-bolt<N>`) are created automatically
by `src/lib/dbaas/kubernetes.ts` at provision time — you don't set those up
by hand.

In `.env`, set:

```sh
DBAAS_EXTERNAL_HOST=<this machine's LAN IP>   # e.g. 10.0.0.106; used for nip.io hostnames
DBAAS_KIND_NODE_CONTAINER=control-plane-dbaas-control-plane  # default already matches `kind create cluster --name control-plane-dbaas`
```

Leave `DBAAS_EXTERNAL_HOST` unset to disable external exposure entirely —
databases still provision and are reachable from other pods in the
cluster (and from the `document-indexing` pipeline worker), just not from
your host machine's Neo4j Browser/driver.

See `docs/discussion/database-as-a-service.md` for the full design
(storage class, backup-on-delete, resource limits) behind this.

## 4. Web console

```sh
just web   # npm run dev -- --host 127.0.0.1, http://127.0.0.1:4321
```

See [`src/README.md`](src/README.md) for the app's structure. In short:
Astro SSR app, Google login for the dashboard, API keys minted from the
dashboard, `/api/*` routes session-authenticated for the dashboard's own
use, `/api/v1/*` bearer-authenticated for the CLI/public API.

## 5. Temporal pipelines

```sh
just pipelines-install
just pipelines-worker-dbaas   # terminal 1
just pipelines-worker-docs    # terminal 2
```

See [`pipelines/README.md`](pipelines/README.md) for the workflow/activity
structure. Both workers connect to the Temporal server started in step 1;
`document-indexing` also needs `OPENAI_API_KEY` (see
`pipelines/.env.example`).

## 6. CLI

```sh
cd cli
go build -o cp ./cmd/cp

export CP_API_KEY=<a key minted from the dashboard's API Keys page>
export CP_API_URL=http://127.0.0.1:4321   # the web console from step 4

./cp auth status
./cp db list
```

See [`cli/README.md`](cli/README.md) for the full command reference and
how it authenticates. API keys themselves are dashboard-only (Google
login → API Keys page → mint) — the CLI only ever consumes one, never
creates one.

## Running the tests

```sh
npm test                          # backend: tests/api-v1.test.ts, vitest.
                                    # Integration tests against a *running*
                                    # web console (step 4) + Postgres (step 1)
                                    # + kind (step 3) — not mocks.
cd cli && go test ./...           # CLI: unit tests, httptest-mocked, no
                                    # running services required
```

## Quick end-to-end sanity check

With everything above running:

```sh
cd cli
go build -o /tmp/cp ./cmd/cp
export CP_API_KEY=<your key>
export CP_API_URL=http://127.0.0.1:4321

/tmp/cp auth status
/tmp/cp db create --name smoke-test --wait   # takes ~1 min against a real kind cluster
/tmp/cp docs index <instance-id> --wait <<< "# Hello"
/tmp/cp docs list <instance-id>
/tmp/cp db rm <instance-id>
```
