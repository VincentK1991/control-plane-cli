import { startTrackedWorkflow } from "@pipelines/core";
import { DeleteNeo4jInstanceWorkflow, ProvisionNeo4jInstanceWorkflow } from "./workflows.js";

/**
 * Manual test entrypoint. In the real app, the Astro API routes under
 * src/pages/api/api-keys/[apiKeyId]/neo4j call startTrackedWorkflow
 * directly and return { jobId } to the dashboard instead of shelling out
 * to Helm and blocking the request.
 *
 * Usage:
 *   npm run start:provision --workspace workflows/dbaas-provisioning -- <instanceId> <releaseName> <namespace>
 *   npm run start:delete    --workspace workflows/dbaas-provisioning -- <instanceId> <releaseName> <namespace>
 */
async function main() {
  const [mode, instanceId, releaseName, namespace] = process.argv.slice(2);
  if (!mode || !instanceId || !releaseName || !namespace) {
    throw new Error("usage: starter.ts <provision|delete> <instanceId> <releaseName> <namespace>");
  }

  const input = { instanceId, releaseName, namespace };

  const { jobId } =
    mode === "provision"
      ? await startTrackedWorkflow({
          workflowType: ProvisionNeo4jInstanceWorkflow,
          taskQueue: "dbaas-provisioning",
          jobId: `provision-${instanceId}`,
          args: [input],
        })
      : await startTrackedWorkflow({
          workflowType: DeleteNeo4jInstanceWorkflow,
          taskQueue: "dbaas-provisioning",
          jobId: `delete-${instanceId}`,
          args: [input],
        });

  console.log(`Started job ${jobId}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
