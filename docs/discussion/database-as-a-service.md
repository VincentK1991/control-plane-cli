# Database as a Service With Neo4j

Status: Discussion

Date: 2026-06-25

## Purpose

This note describes the next control-plane capability: provisioning Neo4j
databases for API-key owners. The goal is to turn the current API-key and usage
metering control plane into a small database-as-a-service platform.

The first target product is a free-tier Neo4j instance with:

- one provisioned Neo4j deployment per requested database
- persistent storage in Kubernetes
- generated URL, username, and password
- APOC and Graph Data Science available
- list and delete operations scoped to the API key owner
- backup and restore procedures
- local Kubernetes testing before production cluster work

## Implemented MVP

The current implementation provisions Neo4j databases from the Astro control
plane into a local kind cluster using the official Neo4j Helm chart.

Implemented files:

```text
src/db/schema.ts
src/lib/db.ts
src/lib/dbaas/neo4j.ts
src/lib/dbaas/kubernetes.ts
src/pages/api/api-keys/[apiKeyId]/neo4j/index.ts
src/pages/api/api-keys/[apiKeyId]/neo4j/[instanceId].ts
src/components/DashboardApp.tsx
drizzle/0007_add_neo4j_instances.sql
```

Implemented behavior:

- `neo4j_instances` stores DBaaS metadata in Postgres.
- The dashboard lists provisioned Neo4j databases under each active API key.
- The dashboard can create a Neo4j database for an API key.
- The dashboard can delete a Neo4j database after destructive confirmation.
- The free tier allows two active Neo4j instances per API key.
- Each instance gets its own Kubernetes namespace derived from the API key id.
- Each instance gets a Helm release, StatefulSet, services, Secret, and PVC.
- Credentials are returned once from the create endpoint and then only the
  Kubernetes Secret reference is stored in Postgres.
- Bolt and HTTP URLs are stored as cluster-internal service DNS names.
- Delete runs a final local backup hook before uninstalling Helm and deleting
  the PVC.

Current API routes:

```text
GET    /api/api-keys/:apiKeyId/neo4j
POST   /api/api-keys/:apiKeyId/neo4j
GET    /api/api-keys/:apiKeyId/neo4j/:instanceId
DELETE /api/api-keys/:apiKeyId/neo4j/:instanceId
```

Current create flow:

```text
1. Dashboard calls POST /api/api-keys/:apiKeyId/neo4j.
2. Route verifies the signed-in user owns the API key.
3. Service checks the two-instance free-tier limit.
4. Service inserts neo4j_instances(status = 'provisioning').
5. Kubernetes adapter creates or labels the tenant namespace.
6. Kubernetes adapter renders a temporary Helm values file.
7. Helm installs neo4j/neo4j with Community Edition, 2 GiB memory, 2 GiB PVC,
   APOC, and Graph Data Science.
8. Adapter waits for the pod to become Ready.
9. Service records StatefulSet, service, PVC, Bolt URL, HTTP URL, and
   status = 'ready'.
10. API returns the instance plus one-time credentials.
```

Current delete flow:

```text
1. Dashboard requires the user to type the database name.
2. Dashboard calls DELETE /api/api-keys/:apiKeyId/neo4j/:instanceId.
3. Route verifies ownership through the API key.
4. Service marks the row status = 'deleting'.
5. Kubernetes adapter reads the Neo4j auth Secret.
6. Kubernetes adapter streams an APOC Cypher export through cypher-shell.
7. Backup stream is written to os.tmpdir()/control-plane-neo4j-backups.
8. Helm release is uninstalled.
9. Kubernetes Secret and PVC are deleted.
10. Service marks status = 'deleted', sets deleted_at and last_backup_at.
```

Current Helm values shape:

```yaml
neo4j:
  name: "<release-name>"
  password: "<generated-password>"
  edition: community
  acceptLicenseAgreement: "yes"
  resources:
    cpu: "500m"
    memory: "2048Mi"

image:
  repository: neo4j
  tag: 5.26-community

volumes:
  data:
    mode: defaultStorageClass
    defaultStorageClass:
      requests:
        storage: 2Gi

services:
  neo4j:
    enabled: true
    spec:
      type: ClusterIP

env:
  NEO4J_PLUGINS: '["apoc","graph-data-science"]'

config:
  dbms.security.procedures.unrestricted: "apoc.*,gds.*"
  dbms.security.procedures.allowlist: "apoc.*,gds.*"
  server.config.strict_validation.enabled: "false"
```

The current backup policy metadata is:

```json
{
  "final_backup_on_delete": true,
  "method": "apoc-cypher-stream"
}
```

Current local environment:

```text
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/control_plane
SESSION_SECRET=local-session-secret
API_KEY_PEPPER=local-api-key-pepper
PUBLIC_GOOGLE_CLIENT_ID=local-dev
DBAAS_NEO4J_ROLLOUT_TIMEOUT_SECONDS=600
```

Start the local dashboard:

```sh
npm run dev -- --host 127.0.0.1 --port 4321
```

Create/list/delete operations require a signed-in dashboard session. The API key
itself is currently the ownership scope for databases, but the DBaaS management
routes are dashboard-session routes rather than bearer API-key routes.

Current verification commands:

```sh
kubectl get statefulset,pod,svc,pvc,secret -n <tenant-namespace>
```

```sh
kubectl exec -n <tenant-namespace> <pod-name> -- \
  cypher-shell -u neo4j -p '<password>' \
  'RETURN apoc.version() AS apoc, gds.version() AS gds;'
```

```cypher
MERGE (a:Person {name: "Ada Lovelace"})
MERGE (b:Person {name: "Grace Hopper"})
MERGE (a)-[:INSPIRED]->(b)
RETURN a, b;
```

## Product Model

The control plane should treat Neo4j databases as owned resources, not as loose
Kubernetes objects. Postgres remains the source of truth for users, API keys,
usage events, and provisioned database records.

The starting ownership model is:

```text
user -> api_key -> neo4j_instances
```

Later, this probably becomes:

```text
organization -> workspace/project -> api_key -> database instances
```

For the MVP, keep the API scoped around API keys:

```text
POST   /api/api-keys/:apiKeyId/neo4j
GET    /api/api-keys/:apiKeyId/neo4j
GET    /api/api-keys/:apiKeyId/neo4j/:instanceId
DELETE /api/api-keys/:apiKeyId/neo4j/:instanceId
```

Provisioning must be asynchronous. Creating Kubernetes resources can take tens
of seconds or minutes, and a dashboard API request should not block until Neo4j
is fully ready.

## Recommended Tenant Shape

Use one standalone Neo4j deployment per provisioned database.

This is the cleanest free-tier shape because Neo4j Community-style deployments
are simplest as single standalone servers. It also gives each tenant its own
PVC, password, service, resource limits, backup boundary, and deletion boundary.

Avoid starting with many logical Neo4j databases inside one shared DBMS. That
requires tighter auth, quota, noisy-neighbor, and backup isolation work. It is a
better fit after the control plane is already operating reliably.

## Control-Plane Data Model

Add a table for provisioned Neo4j instances.

Suggested schema:

```text
neo4j_instances
- id uuid primary key
- user_id uuid not null references users(id) on delete cascade
- api_key_id uuid not null references api_keys(id) on delete cascade
- name text not null
- status text not null
- tier text not null
- namespace text not null
- release_name text not null
- statefulset_name text not null
- service_name text not null
- secret_name text not null
- pvc_name text
- username text not null
- password_secret_ref text not null
- bolt_url text
- http_url text
- plugins jsonb not null default '[]'
- storage_size_gb integer not null
- cpu_request_millicores integer not null
- cpu_limit_millicores integer not null
- memory_request_mb integer not null
- memory_limit_mb integer not null
- backup_policy jsonb not null default '{}'
- last_backup_at timestamptz
- last_error text
- created_at timestamptz not null default now()
- updated_at timestamptz not null default now()
- deleted_at timestamptz
```

Use these statuses:

```text
provisioning
ready
failed
deleting
deleted
```

Keep credentials out of plain Postgres. Store the generated Neo4j password in a
Kubernetes Secret. Store only the secret name and credential metadata in the
control-plane database. If the UI needs to show the password once, encrypt that
one-time display value with a real application secret or KMS key and expire it.

## Kubernetes Resources Per Instance

Each provisioned Neo4j instance should create or own these resources:

```text
Namespace or shared namespace
Secret
ConfigMap
ServiceAccount
Role
RoleBinding
StatefulSet or Neo4j Helm release
PersistentVolumeClaim
Service for Bolt
Service or Ingress for HTTP browser/API access
NetworkPolicy
ResourceQuota
LimitRange
CronJob for dumps, or VolumeSnapshot objects
```

Use labels everywhere:

```yaml
app.kubernetes.io/part-of: control-plane-dbaas
app.kubernetes.io/component: neo4j
control-plane.dev/user-id: "<user-id>"
control-plane.dev/api-key-id: "<api-key-id>"
control-plane.dev/neo4j-instance-id: "<neo4j-instance-id>"
control-plane.dev/tier: "free"
```

Labels are critical for reconciliation, cleanup, cost reporting, support, and
auditing.

## Namespace Strategy

There are two practical namespace options.

Option 1: one namespace per Neo4j instance.

Pros:

- clean deletion boundary
- simple quotas
- simple RBAC
- easy support and inspection

Cons:

- more Kubernetes objects
- namespace churn
- local development is slightly noisier

Option 2: one shared namespace for all free-tier instances.

Pros:

- fewer namespaces
- simpler cluster bootstrap
- easier local testing

Cons:

- cleanup must be label-based
- quotas are less isolated
- mistakes can affect more tenants

Start with one shared namespace for local development, then move to one
namespace per production tenant or per production database when operational
boundaries matter.

## Provisioning Flow

The control-plane API should enqueue work and return immediately.

Recommended flow:

```text
1. User requests a Neo4j database for an API key.
2. API verifies the signed-in user owns that API key.
3. API checks free-tier limits.
4. API inserts neo4j_instances(status = 'provisioning').
5. API records a provisioning job or outbox row.
6. Worker creates Kubernetes Secret, values, and Helm release.
7. Worker waits for StatefulSet readiness.
8. Worker verifies Bolt connectivity.
9. Worker verifies APOC and GDS.
10. Worker updates neo4j_instances(status = 'ready', urls...).
11. Dashboard/API list operation returns the ready resource.
```

Failures should update `status = 'failed'` with `last_error`, not leave the row
ambiguous.

Deletion should also be asynchronous:

```text
1. User deletes a Neo4j database.
2. API verifies ownership.
3. API updates status = 'deleting'.
4. Worker optionally takes a final dump.
5. Worker uninstalls the Helm release or deletes labeled resources.
6. Worker deletes PVC only after policy says data can be destroyed.
7. Worker updates status = 'deleted' and deleted_at = now().
```

For production, do not physically remove metadata rows. Mark them deleted.

## Helm-Based Provisioning

Use the official Neo4j Helm chart unless there is a strong reason to manage raw
StatefulSets directly. The chart already handles the normal Kubernetes shape for
Neo4j.

Add the Helm repository:

```sh
helm repo add neo4j https://helm.neo4j.com/neo4j
helm repo update
```

For local development, the provisioner can render a values file per instance.

Example local values:

```yaml
neo4j:
  name: cp-neo4j-dev-001
  edition: community
  acceptLicenseAgreement: "yes"
  resources:
    cpu: "500m"
    memory: "2Gi"

volumes:
  data:
    mode: defaultStorageClass
    defaultStorageClass:
      requests:
        storage: 2Gi

services:
  neo4j:
    enabled: true
    spec:
      type: ClusterIP

env:
  # Local testing only. Production should use a Kubernetes Secret or the
  # current chart-supported password secret mechanism.
  NEO4J_AUTH: "neo4j/local-dev-password"
  NEO4J_PLUGINS: '["apoc", "graph-data-science"]'

config:
  dbms.security.procedures.unrestricted: "apoc.*,gds.*"
  dbms.security.procedures.allowlist: "apoc.*,gds.*"
  server.config.strict_validation.enabled: "false"
```

The automatic `NEO4J_PLUGINS` download path is useful locally, but it is not the
right production default. For production, build a pinned image with the plugin
JARs already present so startup does not depend on runtime downloads.

Production image approach:

```dockerfile
ARG NEO4J_VERSION
FROM neo4j:${NEO4J_VERSION}

COPY plugins/ /var/lib/neo4j/plugins
RUN cp /var/lib/neo4j/labs/apoc-* /var/lib/neo4j/plugins || true
```

The production provisioner should set `image.customImage` in the Helm values and
pin both the Neo4j version and the plugin versions.

## Local Kubernetes Cluster For Testing

The fastest local loop is Docker Desktop plus either kind or Docker Desktop's
built-in Kubernetes. kind is reproducible and works well for development.

Install local tools:

```sh
brew install kind kubectl helm
```

Create a local cluster:

```sh
kind create cluster --name control-plane-dbaas
kubectl cluster-info --context kind-control-plane-dbaas
```

Verify storage support:

```sh
kubectl get storageclass
```

If no default storage class exists, install a local path provisioner or switch to
Docker Desktop Kubernetes for the first test. Neo4j needs a PVC even in local
testing because persistence is part of the product contract.

Create a namespace:

```sh
kubectl create namespace control-plane-dbaas
```

Add the Neo4j chart:

```sh
helm repo add neo4j https://helm.neo4j.com/neo4j
helm repo update
```

For the first manual local test, either set `neo4j.password` in
`neo4j-values.local.yaml` or let the chart generate a password. The implemented
control-plane provisioner sets `neo4j.password` in a temporary values file and
does not commit local values files that contain real credentials.

Install one local Neo4j instance:

```sh
helm install cp-neo4j-dev-001 neo4j/neo4j \
  --namespace control-plane-dbaas \
  -f neo4j-values.local.yaml
```

Watch startup:

```sh
kubectl -n control-plane-dbaas get pods -w
kubectl -n control-plane-dbaas get pvc
kubectl -n control-plane-dbaas get svc
```

Port-forward Bolt and HTTP:

```sh
kubectl -n control-plane-dbaas port-forward svc/cp-neo4j-dev-001 7474:7474 7687:7687
```

Open Neo4j Browser:

```text
http://localhost:7474
```

Use:

```text
username: neo4j
password: local-dev-password
bolt: bolt://localhost:7687
```

Verify plugins:

```cypher
RETURN apoc.version();
```

```cypher
RETURN gds.version();
```

## Local Control-Plane Integration

Add Kubernetes configuration to the app environment:

```text
KUBECONFIG=/path/to/kubeconfig
DBAAS_NEO4J_HELM_CHART=neo4j/neo4j
DBAAS_NEO4J_IMAGE=neo4j:5.26-community
DBAAS_NEO4J_FREE_STORAGE_GB=2
DBAAS_NEO4J_FREE_CPU_REQUEST_MILLICORES=250
DBAAS_NEO4J_FREE_CPU_LIMIT_MILLICORES=500
DBAAS_NEO4J_FREE_MEMORY_REQUEST_MB=2048
DBAAS_NEO4J_FREE_MEMORY_LIMIT_MB=2048
```

Production should not shell out to `kubectl` and `helm` from request handlers.
Instead:

- API handlers write intent to Postgres.
- A worker performs reconciliation.
- The worker uses the Kubernetes API and a Helm library or controlled Helm CLI
  wrapper.
- The worker records every state transition in Postgres.

The local MVP currently uses a controlled Helm CLI wrapper from the request
path. Move to a worker plus Kubernetes API/server-side apply once the object
model stabilizes.

## Reconciliation

Provisioning needs a reconciler, not only create/delete handlers.

The reconciler should periodically:

- find `provisioning` rows and continue or retry work
- find `deleting` rows and finish cleanup
- compare Postgres records with Kubernetes labels
- mark missing or unhealthy deployments
- refresh URLs and readiness status
- detect failed pods and persist useful error messages
- enforce resource limits and free-tier caps

This makes restarts and partial failures survivable.

## Free-Tier Limits

Initial free-tier defaults should be deliberately small:

```text
instances per API key: 2
storage: 2 GiB
cpu request: 250m
cpu limit: 500m
memory request: 2048 MiB
memory limit: 2048 MiB
backup retention: 1 to 3 dumps
external exposure: disabled by default
```

Expose instances through port-forwarding locally and through a controlled
gateway or ingress in production. Do not give every free instance a public load
balancer by default.

## Future: External HTTP And Bolt Access

The current implementation stores cluster-internal URLs:

```text
bolt://<service>.<namespace>.svc.cluster.local:7687
http://<service>.<namespace>.svc.cluster.local:7474
```

Those URLs work from inside the Kubernetes cluster. Local development currently
uses port-forwarding:

```sh
kubectl -n <namespace> port-forward svc/<service-name> 7474:7474 7687:7687
```

Then users connect to:

```text
Neo4j Browser: http://127.0.0.1:7474
Bolt:          bolt://127.0.0.1:7687
```

For a real DBaaS product, the control plane needs external connection
endpoints so users do not port-forward.

### External Access Goals

External access should provide:

- stable DNS per database or per tenant
- TLS for browser/HTTP and encrypted Bolt
- controlled exposure only for databases that opt in
- auditability in Postgres
- revocable endpoint state
- rate limits and abuse protection
- no cluster-admin credentials in the web app

The `neo4j_instances` row should eventually add endpoint fields:

```text
external_bolt_url text
external_http_url text
external_access_enabled boolean not null default false
external_access_mode text
external_access_last_enabled_at timestamptz
external_access_last_disabled_at timestamptz
```

### Option 1: Per-Instance LoadBalancer Services

The simplest external model is to create a `LoadBalancer` Service for Bolt and
optionally HTTP per database.

Example:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: <release-name>-external-bolt
  namespace: <tenant-namespace>
  annotations:
    service.beta.kubernetes.io/aws-load-balancer-scheme: internet-facing
    service.beta.kubernetes.io/aws-load-balancer-type: nlb
spec:
  type: LoadBalancer
  selector:
    app: <release-name>
  ports:
    - name: bolt
      port: 7687
      targetPort: 7687
```

Pros:

- easiest to reason about
- native TCP support for Bolt
- works well with AWS NLB

Cons:

- expensive for free tier if every database gets a load balancer
- many cloud load balancers to manage
- DNS and certificate automation still required
- direct public database endpoints increase abuse and security risk

This is acceptable for paid tiers or internal testing, but it should not be the
default free-tier exposure model.

### Option 2: Shared TCP Gateway For Bolt

A more scalable model is a shared TCP gateway that routes Bolt traffic to the
right backend service.

Possible implementations:

- Envoy Gateway TCPRoute
- Kubernetes Gateway API TCPRoute
- cloud NLB forwarding to an in-cluster TCP proxy
- HAProxy or Envoy deployed as a shared gateway

Example external shape:

```text
neo4j+s://<instance-id>.bolt.dbaas.example.com:7687
```

The gateway maps SNI or hostname metadata to:

```text
<service-name>.<namespace>.svc.cluster.local:7687
```

Pros:

- one shared external entry point
- better cost profile than one NLB per database
- central place for TLS, rate limits, logging, and access control

Cons:

- more moving pieces
- TCP routing by hostname requires TLS/SNI-aware clients and gateway support
- needs careful testing with Neo4j drivers and routing schemes

For EKS, this is likely the best long-term model for Bolt.

### Option 3: HTTP Browser/API Through Ingress

Neo4j Browser and HTTP can be exposed through normal HTTPS ingress.

Example external shape:

```text
https://<instance-id>.browser.dbaas.example.com
```

A future provisioner can create an Ingress or HTTPRoute:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: <release-name>-browser
  namespace: <tenant-namespace>
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  ingressClassName: alb
  tls:
    - hosts:
        - <instance-id>.browser.dbaas.example.com
      secretName: <release-name>-browser-tls
  rules:
    - host: <instance-id>.browser.dbaas.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: <service-name>
                port:
                  number: 7474
```

Pros:

- standard HTTPS ingress pattern
- easier to secure with cert-manager or AWS ACM
- good browser experience

Cons:

- only solves HTTP/browser access
- Bolt still needs a TCP exposure path
- Neo4j Browser still needs a reachable Bolt URL to run Cypher queries

HTTP browser access should probably be optional. Many users only need Bolt from
their app.

### Option 4: Control-Plane Connection Proxy

Another option is to provide a control-plane managed proxy instead of exposing
database services directly.

Example:

```text
bolt+s://proxy.dbaas.example.com/<instance-id>
https://console.dbaas.example.com/databases/<instance-id>/browser
```

Pros:

- central authentication and authorization
- no direct public service per database
- easier to suspend, rate-limit, and audit

Cons:

- the proxy becomes critical infrastructure
- Bolt is not normal HTTP; proxying driver traffic needs careful protocol and
  TLS handling
- more engineering work than Kubernetes-native Services/Ingress

This is attractive later, but too much for the local MVP.

### Recommended External Access Path

For the next production-oriented iteration:

```text
1. Keep ClusterIP as the default internal service.
2. Add external_access_enabled to neo4j_instances.
3. Add a dashboard action to enable external access.
4. For HTTP Browser, create an HTTPS Ingress/HTTPRoute per enabled instance.
5. For Bolt, start with one of:
   - paid-tier per-instance AWS NLB, or
   - shared TCP gateway if Gateway API TCPRoute works cleanly with Neo4j drivers.
6. Store external_bolt_url and external_http_url in Postgres.
7. Add a disable action that removes external Services/Ingress routes.
8. Add reconciliation that verifies DNS, certs, and endpoint readiness.
```

Recommended URL format:

```text
external_http_url=https://<instance-id>.browser.dbaas.example.com
external_bolt_url=neo4j+s://<instance-id>.bolt.dbaas.example.com:7687
```

Use `neo4j+s://` or `bolt+s://` for TLS-secured production connections. Keep
plain `bolt://` for local port-forwarded development only.

### Security Requirements For External Access

Before exposing endpoints publicly:

- require strong generated passwords
- prefer password rotation support
- support disabling external access independently from deleting the database
- use TLS certificates from ACM or cert-manager
- restrict source CIDRs where possible
- add NetworkPolicy so only the gateway reaches tenant pods
- add request/connection metrics
- record endpoint creation/deletion as usage or audit events
- never expose Kubernetes service names as the public contract

## Backup Options

There are two useful backup paths for the first version.

### Offline Dump

The simplest portable backup is an offline Neo4j dump. It is easy to understand,
works locally, and produces an artifact that can be copied to object storage.
The tradeoff is downtime.

An offline dump has three phases:

```sh
# 1. Stop Neo4j so the store is not being written.
kubectl -n control-plane-dbaas scale statefulset cp-neo4j-dev-001 --replicas=0

# 2. Run a one-shot maintenance pod or job that mounts the same PVC and writes
#    dumps to a backup volume.
neo4j-admin database dump neo4j --to-path=/backups
neo4j-admin database dump system --to-path=/backups

# 3. Start Neo4j again.
kubectl -n control-plane-dbaas scale statefulset cp-neo4j-dev-001 --replicas=1
```

In practice, the dump command should run from a maintenance Kubernetes Job that
mounts the same PVC while Neo4j is stopped:

```sh
neo4j-admin database dump neo4j --to-path=/backups
neo4j-admin database dump system --to-path=/backups
```

Then copy the dump to object storage:

```sh
aws s3 cp /backups/neo4j.dump s3://control-plane-dbaas-backups/<instance-id>/neo4j.dump
aws s3 cp /backups/system.dump s3://control-plane-dbaas-backups/<instance-id>/system.dump
```

For local testing without object storage, copy from the pod:

```sh
kubectl -n control-plane-dbaas cp <backup-pod>:/backups ./backups/cp-neo4j-dev-001
```

Restore into a fresh stopped instance:

```sh
neo4j-admin database load neo4j --from-path=/backups --overwrite-destination=true
neo4j-admin database load system --from-path=/backups --overwrite-destination=true
```

For the MVP, final-delete should take a last dump before removing the PVC unless
the user explicitly chooses immediate destructive deletion.

Local implementation note: the first control-plane implementation uses APOC
streamed Cypher export on delete and writes the result to the control-plane
host temp directory. Production should replace this with object-storage-backed
Neo4j dumps and/or CSI snapshots before tenant backups are treated as durable.

### VolumeSnapshot

If the cluster supports CSI snapshots, use `VolumeSnapshot` for fast snapshots.
This is infrastructure dependent and should be tested with the actual storage
class used in production.

Check snapshot support:

```sh
kubectl get volumesnapshotclass
```

Example snapshot:

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: cp-neo4j-dev-001-20260625
  namespace: control-plane-dbaas
  labels:
    control-plane.dev/neo4j-instance-id: "<instance-id>"
spec:
  volumeSnapshotClassName: "<snapshot-class>"
  source:
    persistentVolumeClaimName: "<neo4j-data-pvc>"
```

Snapshots are fast, but the control plane still needs a consistency policy:

- quiesce writes before snapshot
- put Neo4j in maintenance/offline mode for the safest free-tier path
- record snapshot metadata in Postgres
- periodically test restore

## Backup CronJob Shape

For scheduled dump backups, create a CronJob per instance or a shared CronJob
that discovers instances by label.

Per-instance CronJob shape:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: cp-neo4j-dev-001-dump
  namespace: control-plane-dbaas
spec:
  schedule: "17 3 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: dump
              image: "<pinned-neo4j-image>"
              command:
                - /bin/sh
                - -lc
                - |
                  neo4j-admin database dump neo4j --to-path=/backups
                  neo4j-admin database dump system --to-path=/backups
                  aws s3 sync /backups "s3://control-plane-dbaas-backups/${INSTANCE_ID}/$(date +%Y%m%d%H%M%S)/"
              env:
                - name: INSTANCE_ID
                  value: "<instance-id>"
              volumeMounts:
                - name: data
                  mountPath: /data
                - name: backups
                  mountPath: /backups
          volumes:
            - name: data
              persistentVolumeClaim:
                claimName: "<neo4j-data-pvc>"
            - name: backups
              emptyDir: {}
```

This sketch omits cloud credentials. In production, use workload identity or
short-lived credentials, not static object-storage keys in a Secret.

## Delete Semantics

Deletion needs policy. There are three modes:

```text
soft delete metadata only
delete compute, retain PVC
delete compute and PVC after final backup
```

Default production behavior should be:

```text
mark deleting -> final backup -> uninstall release -> delete PVC -> mark deleted
```

The control plane should retain:

- instance id
- API key id
- final status
- created/deleted timestamps
- final backup location
- deletion request actor

## Security Requirements

Minimum security requirements:

- generate a strong password per instance
- never store raw passwords in normal database columns
- expose Bolt/HTTP only through controlled ingress or internal services
- add NetworkPolicy so free-tier instances cannot talk everywhere by default
- enforce Kubernetes quotas
- label and audit all resources
- avoid cluster-admin credentials in the web app
- use a narrow service account for the provisioner
- separate API request handling from cluster mutation work

The web app should not have broad Kubernetes permissions. A worker service
account should have only the verbs and resource types needed to create, inspect,
update, and delete the DBaaS resources.

## Metering Hooks

Provisioning and runtime operations should emit usage events:

```text
neo4j.instance.provisioned
neo4j.instance.ready
neo4j.instance.deleted
neo4j.storage.gib_hour
neo4j.backup.created
neo4j.backup.bytes_stored
```

For the free tier, metering can be used for internal visibility before billing.
The important thing is to preserve the event model now so paid tiers can reuse
the same ledger later.

## Implementation Status

Completed:

1. Added `neo4j_instances`.
2. Added typed library functions for create, list, get, and delete.
3. Added API routes under `/api/api-keys/[apiKeyId]/neo4j`.
4. Added a Helm-based Kubernetes provisioner.
5. Added dashboard create/list/delete controls.
6. Verified APOC and GDS with Cypher:

```cypher
RETURN apoc.version();
```

```cypher
RETURN gds.version();
```

7. Verified local kind provisioning, PVC persistence, list, delete, and graph
   writes.
8. Added local final-delete backup through APOC streamed Cypher export.

Next:

1. Add `neo4j_backup_artifacts`.
2. Move Kubernetes mutation work from request handlers to a worker queue.
3. Add reconciliation and drift detection.
4. Replace local temp backups with S3-backed dumps and/or CSI snapshots.
5. Add external HTTP/Bolt access without port-forwarding.
6. Add metering events for provision, ready, backup, and delete.

## Decisions And Open Questions

Decisions:

- Local development uses kind.
- Local development uses kind's default/local-path storage and validates backups
  with Neo4j dump jobs instead of production-grade volume snapshots.
- Likely production runs on AWS EKS.
- Likely production storage uses the AWS EBS CSI driver with a custom encrypted
  gp3 StorageClass.
- Likely production snapshots use an AWS EBS CSI VolumeSnapshotClass with
  `deletionPolicy: Retain`.
- Final delete backups use Neo4j dumps copied to S3 before compute and PVC
  removal.
- Production uses one Kubernetes namespace per tenant.
- Free-tier instances expose Bolt only by default.
- Database deletion takes a final backup before compute and storage removal.
- Credentials are displayed once after provisioning.
- Each API key can create up to two free-tier Neo4j instances.

Example likely production StorageClass:

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: dbaas-neo4j-gp3
provisioner: ebs.csi.aws.com
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
parameters:
  type: gp3
  encrypted: "true"
  fsType: ext4
```

Example likely production VolumeSnapshotClass:

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: dbaas-neo4j-ebs-snapshots
driver: ebs.csi.aws.com
deletionPolicy: Retain
```

`Retain` is the safer default for customer database snapshots because deleting a
Kubernetes snapshot object should not accidentally destroy the underlying cloud
snapshot before the control plane has recorded or exported the backup state.

## References

- Neo4j Kubernetes operations manual: https://neo4j.com/docs/operations-manual/current/kubernetes/
- Neo4j Kubernetes plugins: https://neo4j.com/docs/operations-manual/current/kubernetes/plugins/
- Neo4j Docker plugins: https://neo4j.com/docs/operations-manual/current/docker/plugins/
- Neo4j Graph Data Science installation: https://neo4j.com/docs/graph-data-science/current/installation/
- Neo4j Kubernetes dump and load: https://neo4j.com/docs/operations-manual/current/kubernetes/operations/dump-load/
