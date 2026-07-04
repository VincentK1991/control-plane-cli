import { getTemporalClient } from "@pipelines/core";
import { ScheduleAlreadyRunning } from "@temporalio/client";

const SWEEP_INTERVAL = "10 minutes";

/**
 * Ensures a recurring Schedule exists for an instance's normalization
 * sweep. This is an activity, not workflow code, because creating a
 * Schedule is a Temporal *client* operation — workflow code can start
 * child workflows directly, but can't call the client. Called from
 * IndexDocumentWorkflow on every upload for an instance; idempotent, since
 * every call after the first hits ScheduleAlreadyRunning and no-ops.
 */
export async function ensureNormalizationScheduleExists(instanceId: string): Promise<void> {
  const client = await getTemporalClient();

  try {
    await client.schedule.create({
      scheduleId: `normalize-${instanceId}`,
      spec: { intervals: [{ every: SWEEP_INTERVAL }] },
      action: {
        type: "startWorkflow",
        workflowType: "NormalizeEntitiesWorkflow",
        taskQueue: "document-indexing",
        args: [{ instanceId }],
      },
      // Default overlap policy is already SKIP (don't start a new sweep run
      // if the previous one is still going), which is what's wanted here.
    });
  } catch (err) {
    if (!(err instanceof ScheduleAlreadyRunning)) {
      throw err;
    }
  }
}
