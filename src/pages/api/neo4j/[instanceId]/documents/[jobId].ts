import type { APIRoute } from "astro";
import { getNeo4jInstanceForUser } from "../../../../../lib/dbaas/neo4j";
import { getDocumentIndexingJob } from "../../../../../lib/pipelines/documentIndexing";
import { json, requireUser } from "../../../../../lib/responses";

export const prerender = false;

export const GET: APIRoute = async ({ params, cookies }) => {
  const { user, response } = await requireUser(cookies);
  if (!user) {
    return response;
  }

  const instanceId = params.instanceId;
  const jobId = params.jobId;
  if (!instanceId || !jobId) {
    return json({ error: "Missing Neo4j instance ID or job ID." }, { status: 400 });
  }

  const instance = await getNeo4jInstanceForUser(user.id, instanceId);
  if (!instance) {
    return json({ error: "Neo4j instance not found." }, { status: 404 });
  }

  const job = await getDocumentIndexingJob(user.id, instanceId, jobId);
  return job ? json({ job }) : json({ error: "Job not found." }, { status: 404 });
};
