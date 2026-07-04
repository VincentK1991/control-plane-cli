import { Pool } from "pg";
import { config } from "../config.js";

export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export interface CreateJobInput {
  jobId: string;
  workflowType: string;
  taskQueue: string;
  userId?: string;
  apiKeyId?: string;
  input?: Record<string, unknown>;
}

export interface JobRecord {
  id: string;
  workflowType: string;
  taskQueue: string;
  status: JobStatus;
  currentStep: string | null;
  progress: Record<string, unknown>;
  input: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

let pool: Pool | undefined;

/**
 * Raw SQL against `pipeline_jobs` (defined in src/db/schema.ts on the main
 * app side). Kept as plain SQL rather than importing the app's drizzle
 * schema so `pipelines/` has no compile-time dependency on `src/`.
 */
function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: config.controlPlaneDatabaseUrl });
  }
  return pool;
}

export async function createJob(input: CreateJobInput): Promise<void> {
  // ON CONFLICT DO UPDATE, not DO NOTHING: if a caller reuses a natural-key
  // job id (e.g. `provision-<instanceId>`) after a prior attempt never
  // actually got a Temporal workflow started (see startTrackedWorkflow's
  // catch block), this row needs to go back to 'queued' rather than being
  // silently left in whatever terminal state the earlier attempt left it in.
  await getPool().query(
    `insert into pipeline_jobs (id, workflow_type, task_queue, user_id, api_key_id, status, input)
     values ($1, $2, $3, $4, $5, 'queued', $6)
     on conflict (id) do update
        set status = 'queued',
            current_step = null,
            progress = '{}'::jsonb,
            result = null,
            error = null,
            started_at = null,
            completed_at = null,
            updated_at = now()`,
    [
      input.jobId,
      input.workflowType,
      input.taskQueue,
      input.userId ?? null,
      input.apiKeyId ?? null,
      JSON.stringify(input.input ?? {}),
    ],
  );
}

export async function updateJobStatus(
  jobId: string,
  status: JobStatus,
  fields: {
    startedAt?: Date;
    completedAt?: Date;
    result?: Record<string, unknown>;
    error?: string;
  },
): Promise<void> {
  await getPool().query(
    `update pipeline_jobs
        set status = $2,
            started_at = coalesce($3, started_at),
            completed_at = coalesce($4, completed_at),
            result = coalesce($5, result),
            error = coalesce($6, error),
            updated_at = now()
      where id = $1`,
    [
      jobId,
      status,
      fields.startedAt ?? null,
      fields.completedAt ?? null,
      fields.result ? JSON.stringify(fields.result) : null,
      fields.error ?? null,
    ],
  );
}

export async function updateJobProgress(
  jobId: string,
  step: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await getPool().query(
    `update pipeline_jobs
        set current_step = $2,
            progress = progress || jsonb_build_object($2::text, $3::jsonb),
            updated_at = now()
      where id = $1`,
    [jobId, step, JSON.stringify(detail)],
  );
}

export async function getJob(jobId: string): Promise<JobRecord | null> {
  const result = await getPool().query(`select * from pipeline_jobs where id = $1`, [jobId]);
  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    workflowType: row.workflow_type,
    taskQueue: row.task_queue,
    status: row.status,
    currentStep: row.current_step,
    progress: row.progress,
    input: row.input,
    result: row.result,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}
