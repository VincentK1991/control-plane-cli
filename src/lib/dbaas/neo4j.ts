import { randomUUID } from "node:crypto";
import { randomToken } from "../crypto";
import { query } from "../db";
import {
  deleteNeo4jFromKubernetes,
  getNeo4jFreeTierDefaults,
  provisionNeo4jInKubernetes,
  releaseName,
  secretName,
  tenantNamespace,
} from "./kubernetes";

export type Neo4jInstanceStatus =
  | "provisioning"
  | "ready"
  | "failed"
  | "deleting"
  | "deleted";

export type Neo4jInstanceRecord = {
  id: string;
  user_id: string;
  api_key_id: string;
  name: string;
  status: Neo4jInstanceStatus;
  tier: "free";
  namespace: string;
  release_name: string;
  statefulset_name: string;
  service_name: string;
  secret_name: string;
  pvc_name: string | null;
  username: string;
  password_secret_ref: string;
  bolt_url: string | null;
  http_url: string | null;
  external_bolt_url: string | null;
  external_http_url: string | null;
  external_bolt_port: number | null;
  plugins: string[];
  storage_size_gb: number;
  cpu_request_millicores: number;
  cpu_limit_millicores: number;
  memory_request_mb: number;
  memory_limit_mb: number;
  backup_policy: Record<string, unknown>;
  last_backup_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

type ApiKeyOwnership = {
  id: string;
  user_id: string;
  status: "active" | "revoked";
};

export class DbaasError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Serializes provisioning/deletion work per instance ID within this
 * process. Needed once provisioning can run in the background (see
 * createNeo4jInstanceAsync): without it, a delete requested while
 * provisioning is still in flight could run `helm uninstall` concurrently
 * with the `helm install --wait` still in progress for the same release,
 * which Helm itself rejects ("another operation ... is in progress"). A
 * delete now simply queues behind any in-flight provisioning for that
 * instance and runs once it's done, instead of racing it.
 */
const instanceLocks = new Map<string, Promise<unknown>>();

function withInstanceLock<T>(instanceId: string, fn: () => Promise<T>): Promise<T> {
  const prior = instanceLocks.get(instanceId) ?? Promise.resolve();
  const settled = prior.then(fn, fn);
  instanceLocks.set(
    instanceId,
    settled.catch(() => undefined),
  );
  return settled;
}

export async function listNeo4jInstances(userId: string, apiKeyId: string) {
  await requireActiveApiKey(userId, apiKeyId);

  const result = await query<Neo4jInstanceRecord>(
    `
      select *
      from neo4j_instances
      where user_id = $1
        and api_key_id = $2
        and deleted_at is null
      order by created_at desc
    `,
    [userId, apiKeyId],
  );

  return result.rows;
}

export async function getNeo4jInstance(
  userId: string,
  apiKeyId: string,
  instanceId: string,
) {
  await requireActiveApiKey(userId, apiKeyId);

  const result = await query<Neo4jInstanceRecord>(
    `
      select *
      from neo4j_instances
      where id = $1
        and user_id = $2
        and api_key_id = $3
        and deleted_at is null
      limit 1
    `,
    [instanceId, userId, apiKeyId],
  );

  return result.rows[0] ?? null;
}

/**
 * Looks up an instance by user ownership alone, without requiring the
 * caller to also know which API key it was provisioned under. Used by the
 * per-instance database page/routes, whose URLs are scoped by instanceId
 * only (a user owns an instance regardless of which of their API keys it
 * hangs off of).
 */
export async function getNeo4jInstanceForUser(userId: string, instanceId: string) {
  const result = await query<Neo4jInstanceRecord>(
    `
      select *
      from neo4j_instances
      where id = $1
        and user_id = $2
        and deleted_at is null
      limit 1
    `,
    [instanceId, userId],
  );

  return result.rows[0] ?? null;
}

type PendingProvisioning = {
  record: Neo4jInstanceRecord;
  credentials: { username: string; password: string };
  spec: {
    apiKeyId: string;
    instanceId: string;
    userId: string;
    name: string;
    namespace: string;
    releaseName: string;
    secretName: string;
    username: string;
    password: string;
    storageSizeGb: number;
    cpuRequestMillicores: number;
    cpuLimitMillicores: number;
    memoryRequestMb: number;
    memoryLimitMb: number;
    plugins: string[];
  };
};

/**
 * Inserts the neo4j_instances row (status 'provisioning') and returns
 * everything needed to actually provision it in Kubernetes. Split out from
 * the Kubernetes work itself so callers can choose to await provisioning
 * (createNeo4jInstance, for the dashboard) or return immediately and run it
 * in the background (createNeo4jInstanceAsync, for /api/v1).
 */
async function insertProvisioningRecord(
  userId: string,
  apiKeyId: string,
  name: string,
): Promise<PendingProvisioning> {
  await requireActiveApiKey(userId, apiKeyId);
  await enforceFreeTierLimit(userId, apiKeyId);

  const defaults = getNeo4jFreeTierDefaults();
  const id = randomUUID();
  const namespace = tenantNamespace(apiKeyId);
  const release = releaseName(id);
  const secret = secretName(id);
  const username = "neo4j";
  const password = randomToken(24);
  const plugins = ["apoc", "graph-data-science"];

  const inserted = await query<Neo4jInstanceRecord>(
    `
      insert into neo4j_instances (
        id,
        user_id,
        api_key_id,
        name,
        status,
        tier,
        namespace,
        release_name,
        statefulset_name,
        service_name,
        secret_name,
        username,
        password_secret_ref,
        plugins,
        storage_size_gb,
        cpu_request_millicores,
        cpu_limit_millicores,
        memory_request_mb,
        memory_limit_mb,
        backup_policy
      )
      values (
        $1, $2, $3, $4, 'provisioning', 'free', $5, $6, $6, $6, $7, $8, $7,
        $9::jsonb, $10, $11, $12, $13, $14, $15::jsonb
      )
      returning *
    `,
    [
      id,
      userId,
      apiKeyId,
      name,
      namespace,
      release,
      secret,
      username,
      JSON.stringify(plugins),
      defaults.storageSizeGb,
      defaults.cpuRequestMillicores,
      defaults.cpuLimitMillicores,
      defaults.memoryRequestMb,
      defaults.memoryLimitMb,
      JSON.stringify({ final_backup_on_delete: true, method: "apoc-cypher-stream" }),
    ],
  );

  return {
    record: inserted.rows[0],
    credentials: { username, password },
    spec: {
      apiKeyId,
      instanceId: id,
      userId,
      name,
      namespace,
      releaseName: release,
      secretName: secret,
      username,
      password,
      storageSizeGb: defaults.storageSizeGb,
      cpuRequestMillicores: defaults.cpuRequestMillicores,
      cpuLimitMillicores: defaults.cpuLimitMillicores,
      memoryRequestMb: defaults.memoryRequestMb,
      memoryLimitMb: defaults.memoryLimitMb,
      plugins,
    },
  };
}

/**
 * Does the actual Kubernetes provisioning and lands the instance row in a
 * terminal 'ready'/'failed' status. Never throws — provisioning failures
 * are recorded on the row, not propagated, since by the time this runs the
 * caller may already have returned a response referencing this instance ID.
 */
async function runNeo4jProvisioning(pending: PendingProvisioning): Promise<Neo4jInstanceRecord> {
  const { record, spec } = pending;

  try {
    const kubernetes = await provisionNeo4jInKubernetes(spec);

    const updated = await query<Neo4jInstanceRecord>(
      `
        update neo4j_instances
        set
          status = 'ready',
          statefulset_name = $4,
          service_name = $5,
          pvc_name = $6,
          bolt_url = $7,
          http_url = $8,
          external_bolt_url = $9,
          external_http_url = $10,
          external_bolt_port = $11,
          last_error = null,
          updated_at = now()
        where id = $1 and user_id = $2 and api_key_id = $3
        returning *
      `,
      [
        spec.instanceId,
        spec.userId,
        spec.apiKeyId,
        kubernetes.statefulsetName,
        kubernetes.serviceName,
        kubernetes.pvcName,
        kubernetes.boltUrl,
        kubernetes.httpUrl,
        kubernetes.externalBoltUrl,
        kubernetes.externalHttpUrl,
        kubernetes.externalBoltPort,
      ],
    );

    return updated.rows[0];
  } catch (error) {
    const message =
      error instanceof Error ? error.message.slice(0, 4000) : "Provisioning failed.";
    await query(
      `
        update neo4j_instances
        set status = 'failed', last_error = $2, updated_at = now()
        where id = $1
      `,
      [spec.instanceId, message],
    );

    return {
      ...record,
      status: "failed" as const,
      last_error: message,
    };
  }
}

/**
 * Provisions synchronously: the caller gets back a terminal ready/failed
 * instance. Used by the dashboard's existing create route, whose UI shows
 * the returned credentials immediately and doesn't poll for status changes.
 */
export async function createNeo4jInstance(userId: string, apiKeyId: string, name: string) {
  const pending = await insertProvisioningRecord(userId, apiKeyId, name);
  const instance = await withInstanceLock(pending.spec.instanceId, () => runNeo4jProvisioning(pending));
  return { instance, credentials: pending.credentials };
}

/**
 * Provisions asynchronously: returns as soon as the row exists (status
 * 'provisioning'), kicking off the actual Kubernetes work in the
 * background. Used by /api/v1, whose CLI/API callers poll
 * GET /api/v1/databases/{id} (optionally via `cp db create --wait`) rather
 * than blocking the create call itself for the full provisioning duration.
 */
export async function createNeo4jInstanceAsync(userId: string, apiKeyId: string, name: string) {
  const pending = await insertProvisioningRecord(userId, apiKeyId, name);

  withInstanceLock(pending.spec.instanceId, () => runNeo4jProvisioning(pending)).catch((error) => {
    // runNeo4jProvisioning itself never rejects; this only guards against a
    // future change making it throw, so a bug there can't produce an
    // unhandled rejection in a request-less background task.
    console.error(`Background provisioning of ${pending.spec.instanceId} failed unexpectedly:`, error);
  });

  return { instance: pending.record, credentials: pending.credentials };
}

export async function deleteNeo4jInstance(
  userId: string,
  apiKeyId: string,
  instanceId: string,
) {
  const instance = await getNeo4jInstance(userId, apiKeyId, instanceId);

  if (!instance) {
    return null;
  }

  // Queued behind any in-flight createNeo4jInstanceAsync background
  // provisioning for this instance — see withInstanceLock's doc comment.
  return withInstanceLock(instanceId, async () => {
    const deleting = await query<Neo4jInstanceRecord>(
      `
        update neo4j_instances
        set status = 'deleting', updated_at = now()
        where id = $1 and user_id = $2 and api_key_id = $3
        returning *
      `,
      [instanceId, userId, apiKeyId],
    );

    try {
      await deleteNeo4jFromKubernetes({
        namespace: instance.namespace,
        releaseName: instance.release_name,
        secretName: instance.secret_name,
        instanceId: instance.id,
        externalBoltPort: instance.external_bolt_port,
      });

      const deleted = await query<Neo4jInstanceRecord>(
        `
          update neo4j_instances
          set
            status = 'deleted',
            deleted_at = now(),
            updated_at = now(),
            last_backup_at = coalesce(last_backup_at, now()),
            last_error = null
          where id = $1 and user_id = $2 and api_key_id = $3
          returning *
        `,
        [instanceId, userId, apiKeyId],
      );

      return deleted.rows[0];
    } catch (error) {
      const message =
        error instanceof Error ? error.message.slice(0, 4000) : "Deletion failed.";
      const failed = await query<Neo4jInstanceRecord>(
        `
          update neo4j_instances
          set status = 'failed', last_error = $4, updated_at = now()
          where id = $1 and user_id = $2 and api_key_id = $3
          returning *
        `,
        [instanceId, userId, apiKeyId, message],
      );

      return failed.rows[0] ?? deleting.rows[0];
    }
  });
}

async function requireActiveApiKey(userId: string, apiKeyId: string) {
  const result = await query<ApiKeyOwnership>(
    `
      select id, user_id, status
      from api_keys
      where id = $1 and user_id = $2
      limit 1
    `,
    [apiKeyId, userId],
  );

  const apiKey = result.rows[0];

  if (!apiKey) {
    throw new DbaasError("API key not found.", 404);
  }

  if (apiKey.status !== "active") {
    throw new DbaasError("API key is revoked.", 409);
  }

  return apiKey;
}

async function enforceFreeTierLimit(userId: string, apiKeyId: string) {
  const result = await query<{ count: string }>(
    `
      select count(*)::text
      from neo4j_instances
      where user_id = $1
        and api_key_id = $2
        and deleted_at is null
        and status in ('provisioning', 'ready', 'failed')
    `,
    [userId, apiKeyId],
  );

  if (Number(result.rows[0]?.count ?? 0) >= 2) {
    throw new DbaasError("Free tier allows two Neo4j instances per API key.", 409);
  }
}
