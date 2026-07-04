import { execFile } from "node:child_process";
import { promisify } from "node:util";
import neo4j, { type Driver } from "neo4j-driver";
import type { Neo4jInstanceRecord } from "./controlPlaneDb.js";

const execFileAsync = promisify(execFile);

/**
 * Resolves the generated password for an instance from its Kubernetes
 * Secret. Mirrors the lookup already implemented in
 * src/lib/dbaas/kubernetes.ts (getNeo4jAuth) on the main app side — same
 * Secret shape (`NEO4J_AUTH`, base64-encoded `username/password`) — but
 * pipelines shell out to `kubectl` directly with their own kubeconfig
 * rather than importing app code, keeping the two services' cluster
 * credentials separate.
 */
async function readNeo4jPassword(instance: Neo4jInstanceRecord): Promise<string> {
  const result = await execFileAsync("kubectl", [
    "get",
    "secret",
    instance.secretName,
    "-n",
    instance.namespace,
    "-o",
    "jsonpath={.data.NEO4J_AUTH}",
  ]);

  const encoded = result.stdout.trim();
  if (!encoded) {
    throw new Error(
      `Secret "${instance.secretName}" in namespace "${instance.namespace}" has no NEO4J_AUTH key`,
    );
  }

  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const separatorIndex = decoded.indexOf("/");
  if (separatorIndex < 0) {
    throw new Error(`NEO4J_AUTH in secret "${instance.secretName}" is not in "user/password" form`);
  }

  return decoded.slice(separatorIndex + 1);
}

export async function openNeo4jDriver(instance: Neo4jInstanceRecord): Promise<Driver> {
  // Prefer the external URL: pipeline workers run on the host, not inside
  // the cluster, so the cluster-internal bolt_url (*.svc.cluster.local)
  // doesn't resolve. external_bolt_url is the same column the main app
  // populates when a user enables external access (see
  // docs/discussion/database-as-a-service.md); local dev without that
  // enabled needs a `kubectl port-forward` and external_bolt_url pointed
  // at it manually.
  const boltUrl = instance.externalBoltUrl ?? instance.boltUrl;
  if (!boltUrl) {
    throw new Error(`Neo4j instance ${instance.id} has no bolt_url or external_bolt_url recorded yet`);
  }

  const password = await readNeo4jPassword(instance);
  return neo4j.driver(boltUrl, neo4j.auth.basic("neo4j", password));
}
