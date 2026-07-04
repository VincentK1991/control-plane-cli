import { randomUUID } from "node:crypto";
import { Client, Connection } from "@temporalio/client";
import { query } from "../db";

/**
 * Minimal Temporal client for starting/reading document-indexing jobs from
 * the dashboard. Deliberately not a dependency on pipelines/core — the
 * pipelines monorepo is a separate npm project by design (see
 * docs/discussion/temporal-pipelines-plan.md), so this duplicates the small
 * amount of client-side logic (start a tracked workflow, read pipeline_jobs)
 * rather than linking the two projects' dependency graphs together.
 */

let temporalClient: Promise<Client> | undefined;

function getTemporalClient(): Promise<Client> {
  if (!temporalClient) {
    const address = process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233";
    const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
    temporalClient = Connection.connect({ address }).then(
      (connection) => new Client({ connection, namespace }),
    );
  }
  return temporalClient;
}

export type DocumentIndexingJobStatus = "queued" | "running" | "succeeded" | "failed";

export type DocumentIndexingJob = {
  id: string;
  status: DocumentIndexingJobStatus;
  current_step: string | null;
  progress: Record<string, unknown>;
  error: string | null;
  created_at: string;
  updated_at: string;
};

const MAX_DOCUMENT_BYTES = 200_000;

export class DocumentIndexingError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export function validateDocumentContent(content: unknown): string {
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new DocumentIndexingError("Document content is required.", 400);
  }
  if (Buffer.byteLength(content, "utf8") > MAX_DOCUMENT_BYTES) {
    throw new DocumentIndexingError(
      `Document is too large (max ${MAX_DOCUMENT_BYTES / 1000}KB).`,
      400,
    );
  }
  return content;
}

/**
 * Starts IndexDocumentWorkflow on the document-indexing task queue and
 * records a pipeline_jobs row up front, mirroring
 * pipelines/core's startTrackedWorkflow: the caller gets a job ID back
 * immediately instead of waiting on extraction/write to finish.
 */
export async function startDocumentIndexingJob(params: {
  userId: string;
  apiKeyId: string;
  instanceId: string;
  content: string;
}): Promise<{ jobId: string }> {
  const jobId = randomUUID();
  const input = {
    instanceId: params.instanceId,
    source: { type: "markdown" as const, content: params.content },
  };

  await query(
    `
      insert into pipeline_jobs (id, workflow_type, task_queue, user_id, api_key_id, status, input)
      values ($1, 'IndexDocumentWorkflow', 'document-indexing', $2, $3, 'queued', $4::jsonb)
    `,
    [jobId, params.userId, params.apiKeyId, JSON.stringify(input)],
  );

  try {
    const client = await getTemporalClient();
    await client.workflow.start("IndexDocumentWorkflow", {
      taskQueue: "document-indexing",
      workflowId: jobId,
      args: [input],
    });
  } catch (error) {
    // Job row exists (status 'queued') but no workflow execution will ever
    // update it — mark it failed so it doesn't look stuck. Same reasoning
    // as pipelines/core's startTrackedWorkflow.
    await query(
      `update pipeline_jobs set status = 'failed', error = $2, completed_at = now(), updated_at = now() where id = $1`,
      [jobId, error instanceof Error ? error.message : "Failed to start workflow."],
    );
    throw error;
  }

  return { jobId };
}

export async function listDocumentIndexingJobs(
  userId: string,
  instanceId: string,
): Promise<DocumentIndexingJob[]> {
  const result = await query<DocumentIndexingJob>(
    `
      select id, status, current_step, progress, error, created_at, updated_at
      from pipeline_jobs
      where user_id = $1
        and task_queue = 'document-indexing'
        and input->>'instanceId' = $2
      order by created_at desc
      limit 20
    `,
    [userId, instanceId],
  );

  return result.rows;
}

export async function getDocumentIndexingJob(
  userId: string,
  instanceId: string,
  jobId: string,
): Promise<DocumentIndexingJob | null> {
  const result = await query<DocumentIndexingJob>(
    `
      select id, status, current_step, progress, error, created_at, updated_at
      from pipeline_jobs
      where id = $1
        and user_id = $2
        and input->>'instanceId' = $3
      limit 1
    `,
    [jobId, userId, instanceId],
  );

  return result.rows[0] ?? null;
}
