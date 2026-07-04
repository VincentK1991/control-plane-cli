import { NativeConnection, Worker } from "@temporalio/worker";
import { config } from "../config.js";
import * as jobActivities from "../activities/jobActivities.js";

export interface PipelineWorkerConfig {
  taskQueue: string;
  /** Usually `require.resolve("./workflows")` from the calling package. */
  workflowsPath: string;
  /** That pipeline's own activities — jobActivities is merged in automatically. */
  activities: Record<string, (...args: never[]) => Promise<unknown>>;
}

/**
 * Everything a pipeline's worker.ts needs beyond its own taskQueue,
 * workflowsPath, and activities: connecting to Temporal, merging in the
 * job-tracking activities every pipeline needs (so individual packages
 * don't spread `jobActivities` by hand), running the worker, and exiting
 * on fatal startup errors. A new pipeline package's worker.ts is just:
 *
 *   import { startPipelineWorker } from "@pipelines/core/worker";
 *   import * as activities from "./activities.js";
 *
 *   void startPipelineWorker({
 *     taskQueue: "my-new-pipeline",
 *     workflowsPath: require.resolve("./workflows"),
 *     activities,
 *   });
 *
 * Nothing in @pipelines/core itself needs to change to add a pipeline.
 */
export async function startPipelineWorker(workerConfig: PipelineWorkerConfig): Promise<void> {
  try {
    const connection = await NativeConnection.connect({ address: config.temporal.address });

    const worker = await Worker.create({
      connection,
      namespace: config.temporal.namespace,
      taskQueue: workerConfig.taskQueue,
      workflowsPath: workerConfig.workflowsPath,
      activities: { ...workerConfig.activities, ...jobActivities },
    });

    await worker.run();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
