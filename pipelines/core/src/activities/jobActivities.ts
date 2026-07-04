import * as jobsDb from "../clients/jobsDb.js";

/**
 * Temporal activities every workflow package spreads into its own
 * `activities` map (see each package's src/worker.ts) so the workflow-side
 * decorator in `@pipelines/core/workflow` has something to call. Kept as
 * plain named activities, not a class, so they compose with each
 * package's own activities via object spread.
 */

export async function markJobRunning(jobId: string): Promise<void> {
  await jobsDb.updateJobStatus(jobId, "running", { startedAt: new Date() });
}

export async function markJobProgress(
  jobId: string,
  step: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  await jobsDb.updateJobProgress(jobId, step, detail ?? {});
}

export async function markJobSucceeded(
  jobId: string,
  result?: Record<string, unknown>,
): Promise<void> {
  await jobsDb.updateJobStatus(jobId, "succeeded", { completedAt: new Date(), result });
}

export async function markJobFailed(jobId: string, error: string): Promise<void> {
  await jobsDb.updateJobStatus(jobId, "failed", { completedAt: new Date(), error });
}
