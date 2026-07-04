import type { APIRoute } from "astro";
import { getNeo4jInstanceForUser } from "../../../../../lib/dbaas/neo4j";
import {
  DocumentIndexingError,
  listDocumentIndexingJobs,
  startDocumentIndexingJob,
  validateDocumentContent,
} from "../../../../../lib/pipelines/documentIndexing";
import { json, readJson, requireUser } from "../../../../../lib/responses";

export const prerender = false;

export const GET: APIRoute = async ({ params, cookies }) => {
  const { user, response } = await requireUser(cookies);
  if (!user) {
    return response;
  }

  const instanceId = params.instanceId;
  if (!instanceId) {
    return json({ error: "Missing Neo4j instance ID." }, { status: 400 });
  }

  const instance = await getNeo4jInstanceForUser(user.id, instanceId);
  if (!instance) {
    return json({ error: "Neo4j instance not found." }, { status: 404 });
  }

  const jobs = await listDocumentIndexingJobs(user.id, instanceId);
  return json({ jobs });
};

export const POST: APIRoute = async ({ params, request, cookies }) => {
  const { user, response } = await requireUser(cookies);
  if (!user) {
    return response;
  }

  const instanceId = params.instanceId;
  if (!instanceId) {
    return json({ error: "Missing Neo4j instance ID." }, { status: 400 });
  }

  const instance = await getNeo4jInstanceForUser(user.id, instanceId);
  if (!instance) {
    return json({ error: "Neo4j instance not found." }, { status: 404 });
  }
  if (instance.status !== "ready") {
    return json(
      { error: `Database is not ready yet (status: ${instance.status}).` },
      { status: 409 },
    );
  }

  const body = await readJson<{ content?: string }>(request);
  if (!body) {
    return json({ error: "Invalid JSON body." }, { status: 400 });
  }

  try {
    const content = validateDocumentContent(body.content);
    const { jobId } = await startDocumentIndexingJob({
      userId: user.id,
      apiKeyId: instance.api_key_id,
      instanceId,
      content,
    });

    return json({ jobId }, { status: 202 });
  } catch (error) {
    if (error instanceof DocumentIndexingError) {
      return json({ error: error.message }, { status: error.status });
    }
    return json({ error: "Failed to start document indexing." }, { status: 500 });
  }
};
