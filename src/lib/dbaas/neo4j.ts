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

export async function createNeo4jInstance(
  userId: string,
  apiKeyId: string,
  name: string,
) {
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

  const record = inserted.rows[0];

  try {
    const kubernetes = await provisionNeo4jInKubernetes({
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
    });

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
        id,
        userId,
        apiKeyId,
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

    return {
      instance: updated.rows[0],
      credentials: {
        username,
        password,
      },
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message.slice(0, 4000) : "Provisioning failed.";
    await query(
      `
        update neo4j_instances
        set status = 'failed', last_error = $2, updated_at = now()
        where id = $1
      `,
      [id, message],
    );

    return {
      instance: {
        ...record,
        status: "failed" as const,
        last_error: message,
      },
      credentials: {
        username,
        password,
      },
    };
  }
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
