import type { APIRoute } from "astro";
import { DbaasError, deleteNeo4jInstance, getNeo4jInstance } from "../../../../lib/dbaas/neo4j";
import { json, requireApiKey } from "../../../../lib/responses";

export const prerender = false;

export const GET: APIRoute = async ({ params, request }) => {
  const { auth, response } = await requireApiKey(request);
  if (!auth) {
    return response;
  }

  const instanceId = params.instanceId;
  if (!instanceId) {
    return json({ error: "Missing Neo4j instance ID." }, { status: 400 });
  }

  try {
    const instance = await getNeo4jInstance(auth.user_id, auth.api_key_id, instanceId);

    return instance
      ? json({ instance })
      : json({ error: "Neo4j instance not found." }, { status: 404 });
  } catch (error) {
    return dbaasErrorResponse(error);
  }
};

export const DELETE: APIRoute = async ({ params, request }) => {
  const { auth, response } = await requireApiKey(request);
  if (!auth) {
    return response;
  }

  const instanceId = params.instanceId;
  if (!instanceId) {
    return json({ error: "Missing Neo4j instance ID." }, { status: 400 });
  }

  try {
    const instance = await deleteNeo4jInstance(auth.user_id, auth.api_key_id, instanceId);

    return instance
      ? json({ instance })
      : json({ error: "Neo4j instance not found." }, { status: 404 });
  } catch (error) {
    return dbaasErrorResponse(error);
  }
};

function dbaasErrorResponse(error: unknown) {
  if (error instanceof DbaasError) {
    return json({ error: error.message }, { status: error.status });
  }

  return json({ error: "Neo4j database operation failed." }, { status: 500 });
}
