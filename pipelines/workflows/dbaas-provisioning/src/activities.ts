/**
 * Activities do the actual side-effecting work (Helm, kubectl, Postgres
 * status updates). They mirror the steps already described in
 * docs/discussion/database-as-a-service.md, moved from request-time Helm
 * CLI calls into durable, retryable Temporal activities.
 */

export interface ProvisionInput {
  instanceId: string;
  releaseName: string;
  namespace: string;
}

export interface ProvisionedEndpoints {
  boltUrl: string;
  httpUrl: string;
}

export async function createHelmRelease(input: ProvisionInput): Promise<void> {
  throw new Error(
    `TODO: render Helm values and \`helm install ${input.releaseName} neo4j/neo4j\` ` +
      `in namespace ${input.namespace}`,
  );
}

export async function waitForStatefulSetReady(input: ProvisionInput): Promise<void> {
  throw new Error(
    `TODO: poll the StatefulSet for release ${input.releaseName} until Ready, ` +
      "heartbeating so Temporal knows this activity is still alive",
  );
}

export async function verifyApocAndGds(input: ProvisionInput): Promise<void> {
  throw new Error(`TODO: run \`RETURN apoc.version(), gds.version()\` against ${input.releaseName}`);
}

export async function markReady(
  instanceId: string,
  endpoints: ProvisionedEndpoints,
): Promise<void> {
  throw new Error(
    `TODO: set neo4j_instances.status = 'ready', bolt_url = ${endpoints.boltUrl}, ` +
      `http_url = ${endpoints.httpUrl} for ${instanceId}`,
  );
}

export async function markFailed(instanceId: string, reason: string): Promise<void> {
  throw new Error(`TODO: set neo4j_instances.status = 'failed', last_error = '${reason}' for ${instanceId}`);
}

export async function markDeleting(instanceId: string): Promise<void> {
  throw new Error(`TODO: set neo4j_instances.status = 'deleting' for ${instanceId}`);
}

export async function takeFinalBackup(input: ProvisionInput): Promise<string> {
  throw new Error(
    `TODO: stream an APOC/neo4j-admin export for ${input.releaseName} to object storage ` +
      "and return the backup location",
  );
}

export async function uninstallHelmRelease(input: ProvisionInput): Promise<void> {
  throw new Error(`TODO: \`helm uninstall ${input.releaseName}\` in namespace ${input.namespace}`);
}

export async function deleteSecretAndPvc(input: ProvisionInput): Promise<void> {
  throw new Error(`TODO: delete the Secret and PVC for release ${input.releaseName}`);
}

export async function markDeleted(instanceId: string, backupLocation: string): Promise<void> {
  throw new Error(
    `TODO: set neo4j_instances.status = 'deleted', deleted_at = now(), ` +
      `last_backup_at = now() (backup at ${backupLocation}) for ${instanceId}`,
  );
}
