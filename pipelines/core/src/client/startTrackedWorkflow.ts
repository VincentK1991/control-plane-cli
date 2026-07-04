import { randomUUID } from "node:crypto";
import type { Workflow } from "@temporalio/workflow";
import type { WorkflowStartOptions } from "@temporalio/client";
import { getTemporalClient } from "../clients/temporalClient.js";
import { createJob, updateJobStatus } from "../clients/jobsDb.js";

export interface StartTrackedWorkflowInput<T extends Workflow> {
  /** The workflow function itself (imported from a workflows.ts module). */
  workflowType: T;
  taskQueue: string;
  args: Parameters<T>;
  /**
   * Defaults to a random UUID. Pass an explicit id (e.g.
   * `provision-<instanceId>`) when the workflow should dedupe against a
   * natural key — Temporal rejects starting a *second* execution on an ID
   * that already has one running (WorkflowExecutionAlreadyStartedError),
   * which is exactly the dedupe behavior a natural key wants.
   */
  jobId?: string;
  userId?: string;
  apiKeyId?: string;
}

/**
 * The one function every "upload a document" / "create a database" style
 * API route calls: inserts a `pipeline_jobs` row (status = queued), starts
 * the workflow with that same ID, and returns the job ID immediately so the
 * caller can respond to the user without waiting on the workflow. This is
 * the shared piece the DBaaS-provisioning and document-indexing pipelines
 * (and any future one) both call — new pipelines don't reimplement it.
 *
 * Progress and lifecycle updates after this point come from
 * `withJobTracking`/`reportProgress` in `@pipelines/core/workflow`, run
 * from inside the workflow itself.
 */
export async function startTrackedWorkflow<T extends Workflow>(
  input: StartTrackedWorkflowInput<T>,
): Promise<{ jobId: string }> {
  const jobId = input.jobId ?? randomUUID();

  await createJob({
    jobId,
    workflowType: input.workflowType.name,
    taskQueue: input.taskQueue,
    userId: input.userId,
    apiKeyId: input.apiKeyId,
    input: (input.args[0] as Record<string, unknown>) ?? {},
  });

  const client = await getTemporalClient();
  try {
    // Parameters<T> for a still-generic T doesn't structurally satisfy the
    // tuple check WorkflowStartOptions' conditional `args` type performs,
    // even though any concrete instantiation of T works fine — a known TS
    // limitation with conditional types over open generics, not a real type
    // mismatch. Cast at this single call site rather than loosen the public
    // StartTrackedWorkflowInput<T> signature.
    await client.workflow.start(input.workflowType, {
      taskQueue: input.taskQueue,
      workflowId: jobId,
      args: input.args,
    } as unknown as WorkflowStartOptions<T>);
  } catch (err) {
    // The job row exists (status 'queued') but no workflow execution will
    // ever update it — mark it failed here so it doesn't look stuck.
    await updateJobStatus(jobId, "failed", {
      completedAt: new Date(),
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  return { jobId };
}

export { getJob as getJobStatus } from "../clients/jobsDb.js";
export type { JobRecord, JobStatus } from "../clients/jobsDb.js";
