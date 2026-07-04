import { Pool } from "pg";
import { config } from "../config.js";

export type Neo4jInstanceStatus = "provisioning" | "ready" | "failed" | "deleting" | "deleted";

export interface Neo4jInstanceRecord {
  id: string;
  userId: string;
  apiKeyId: string;
  name: string;
  status: Neo4jInstanceStatus;
  namespace: string;
  releaseName: string;
  secretName: string;
  boltUrl: string | null;
  httpUrl: string | null;
  externalBoltUrl: string | null;
  externalHttpUrl: string | null;
}

let pool: Pool | undefined;

/**
 * Read-only access to the control-plane Postgres database. Activities use
 * this to look up which Neo4j instance a workflow is targeting; they never
 * write through this pool. Writes to control-plane tables happen through
 * the main app (src/lib/dbaas) or through dedicated activities that are
 * explicit about the columns they update (see workflows/dbaas-provisioning).
 */
function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: config.controlPlaneDatabaseUrl });
  }
  return pool;
}

export async function getReadyNeo4jInstance(instanceId: string): Promise<Neo4jInstanceRecord> {
  const result = await getPool().query(
    `select id, user_id, api_key_id, name, status, namespace, release_name,
            secret_name, bolt_url, http_url, external_bolt_url, external_http_url
       from neo4j_instances
      where id = $1`,
    [instanceId],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error(`Neo4j instance not found: ${instanceId}`);
  }
  if (row.status !== "ready") {
    throw new Error(`Neo4j instance ${instanceId} is not ready (status: ${row.status})`);
  }

  return {
    id: row.id,
    userId: row.user_id,
    apiKeyId: row.api_key_id,
    name: row.name,
    status: row.status,
    namespace: row.namespace,
    releaseName: row.release_name,
    secretName: row.secret_name,
    boltUrl: row.bolt_url,
    httpUrl: row.http_url,
    externalBoltUrl: row.external_bolt_url,
    externalHttpUrl: row.external_http_url,
  };
}
