import { proxyActivities, workflowInfo } from "@temporalio/workflow";
// Type-only: erased at compile time, so jobActivities.ts (which imports
// `pg`) never gets pulled into the deterministic workflow bundle. Only the
// function *signatures* are used here; the real implementations run in the
// worker process via proxyActivities.
import type * as jobActivities from "../activities/jobActivities.js";

const { markJobRunning, markJobProgress, markJobSucceeded, markJobFailed } =
  proxyActivities<typeof jobActivities>({
    startToCloseTimeout: "30 seconds",
    retry: { maximumAttempts: 5 },
  });

/**
 * Wraps a workflow's entry-point function so every workflow gets job-status
 * lifecycle tracking (queued -> running -> succeeded/failed) for free,
 * without each workflow author writing the try/catch by hand:
 *
 *   export const ProvisionNeo4jInstanceWorkflow = withJobTracking(
 *     "ProvisionNeo4jInstanceWorkflow",
 *     async (input: ProvisionNeo4jInstanceInput) => { ... },
 *   );
 *
 * `name` must match the exported const's own name. Temporal's worker looks
 * up workflow implementations by the *export name* in workflows.ts (so that
 * part works regardless), but the client's `workflow.start(fn, ...)` reads
 * `fn.name` to know which workflow type to ask the server to run — and the
 * function this returns would otherwise be anonymous, since it's the return
 * value of a call rather than a bare `const x = () => {}` (which is the one
 * case JS auto-names). Passing `name` explicitly and stamping it onto the
 * wrapper keeps `startTrackedWorkflow` able to accept a plain function
 * reference instead of a separate string at every call site.
 *
 * The job row itself is created by `startTrackedWorkflow` (in
 * `@pipelines/core/client`) *before* the workflow starts, using the same ID
 * as the Temporal workflow ID — this decorator only transitions status
 * during execution, it never creates the row.
 */
export function withJobTracking<Args extends unknown[], R>(
  name: string,
  workflowFn: (...args: Args) => Promise<R>,
): (...args: Args) => Promise<R> {
  const wrapped = async (...args: Args): Promise<R> => {
    const jobId = workflowInfo().workflowId;
    await markJobRunning(jobId);

    try {
      const result = await workflowFn(...args);
      await markJobSucceeded(jobId, isPlainObject(result) ? result : { value: result });
      return result;
    } catch (err) {
      await markJobFailed(jobId, err instanceof Error ? err.message : String(err));
      throw err;
    }
  };

  Object.defineProperty(wrapped, "name", { value: name, configurable: true });
  return wrapped;
}

/**
 * Call between steps inside a tracked workflow body to record progress
 * finer-grained than the overall queued/running/succeeded/failed lifecycle
 * (e.g. "creating-helm-release", "waiting-for-ready"). Reads the job ID
 * from the current workflow's execution context, so callers never thread
 * jobId through manually.
 */
export async function reportProgress(
  step: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  await markJobProgress(workflowInfo().workflowId, step, detail);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
