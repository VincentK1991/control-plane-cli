import { proxyActivities } from "@temporalio/workflow";
import { reportProgress, withJobTracking } from "@pipelines/core/workflow";
import type * as activities from "./activities.js";

const {
  createHelmRelease,
  waitForStatefulSetReady,
  verifyApocAndGds,
  markReady,
  markFailed,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: "10 minutes",
  retry: { maximumAttempts: 5 },
});

const {
  markDeleting,
  takeFinalBackup,
  uninstallHelmRelease,
  deleteSecretAndPvc,
  markDeleted,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: "10 minutes",
  retry: { maximumAttempts: 5 },
});

export interface ProvisionNeo4jInstanceInput {
  instanceId: string;
  releaseName: string;
  namespace: string;
}

/**
 * Started the moment a user clicks "create database". The API route only
 * needs to call startTrackedWorkflow (@pipelines/core/client) and return
 * the job ID it gets back — this workflow, wrapped in withJobTracking,
 * takes the job row from 'queued' through 'running' to
 * 'succeeded'/'failed' on its own, with per-step progress in between via
 * reportProgress.
 */
export const ProvisionNeo4jInstanceWorkflow = withJobTracking(
  "ProvisionNeo4jInstanceWorkflow",
  async (input: ProvisionNeo4jInstanceInput): Promise<void> => {
    try {
      await reportProgress("creating-helm-release");
      await createHelmRelease(input);

      await reportProgress("waiting-for-statefulset-ready");
      await waitForStatefulSetReady(input);

      await reportProgress("verifying-apoc-and-gds");
      await verifyApocAndGds(input);

      await reportProgress("marking-ready");
      await markReady(input.instanceId, {
        boltUrl: `bolt://${input.releaseName}.${input.namespace}.svc.cluster.local:7687`,
        httpUrl: `http://${input.releaseName}.${input.namespace}.svc.cluster.local:7474`,
      });
    } catch (err) {
      await markFailed(input.instanceId, err instanceof Error ? err.message : String(err));
      throw err;
    }
  },
);

export interface DeleteNeo4jInstanceInput {
  instanceId: string;
  releaseName: string;
  namespace: string;
}

export const DeleteNeo4jInstanceWorkflow = withJobTracking(
  "DeleteNeo4jInstanceWorkflow",
  async (input: DeleteNeo4jInstanceInput): Promise<void> => {
    await reportProgress("marking-deleting");
    await markDeleting(input.instanceId);

    await reportProgress("taking-final-backup");
    const backupLocation = await takeFinalBackup(input);

    await reportProgress("uninstalling-helm-release");
    await uninstallHelmRelease(input);

    await reportProgress("deleting-secret-and-pvc");
    await deleteSecretAndPvc(input);

    await reportProgress("marking-deleted");
    await markDeleted(input.instanceId, backupLocation);
  },
);
