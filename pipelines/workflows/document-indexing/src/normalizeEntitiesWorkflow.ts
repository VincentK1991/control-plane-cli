import { proxyActivities } from "@temporalio/workflow";
import type * as normalizationActivities from "./normalizationActivities.js";

const { getSweepCheckpoint, hasNewNodesSince, proposeMerges, applyMerges, setSweepCheckpoint } =
  proxyActivities<typeof normalizationActivities>({
    startToCloseTimeout: "5 minutes",
    retry: { maximumAttempts: 3 },
  });

export interface NormalizeEntitiesInput {
  instanceId: string;
}

/**
 * One sweep, run once per invocation — recurrence comes from a Temporal
 * Schedule (`normalize-<instanceId>`, every 10 minutes), created lazily by
 * the ensureNormalizationScheduleExists activity the first time a document
 * is uploaded for that instance (see documentIndexingWorkflow.ts). Not a
 * sleep-loop + continueAsNew workflow: each scheduled run is a fresh
 * execution, which is a better fit for something this simple (no state to
 * carry between runs beyond a timestamp) and gets Temporal's native
 * Schedule pause/visibility for free.
 *
 * Because each run is a fresh execution, the "how far have we swept"
 * checkpoint can't ride along as workflow input the way it would in a
 * continueAsNew loop — it's read from and written back to the instance's
 * own Neo4j graph instead (getSweepCheckpoint/setSweepCheckpoint in
 * normalizationActivities.ts).
 */
export async function NormalizeEntitiesWorkflow(input: NormalizeEntitiesInput): Promise<void> {
  const since = await getSweepCheckpoint(input.instanceId);

  const hasNew = await hasNewNodesSince(input.instanceId, since);
  if (!hasNew) {
    return;
  }

  const decisions = await proposeMerges(input.instanceId, since);
  if (decisions.length > 0) {
    await applyMerges(input.instanceId, decisions);
  }

  await setSweepCheckpoint(input.instanceId, new Date().toISOString());
}
