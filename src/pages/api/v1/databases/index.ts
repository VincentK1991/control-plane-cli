import type { APIRoute } from "astro";
import { createNeo4jInstanceAsync, DbaasError, listNeo4jInstances } from "../../../../lib/dbaas/neo4j";
import { json, readJson, requireApiKey } from "../../../../lib/responses";

type CreateDatabaseBody = {
  name?: string;
};

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const { auth, response } = await requireApiKey(request);
  if (!auth) {
    return response;
  }

  try {
    const instances = await listNeo4jInstances(auth.user_id, auth.api_key_id);
    return json({ instances });
  } catch (error) {
    return dbaasErrorResponse(error);
  }
};

export const POST: APIRoute = async ({ request }) => {
  const { auth, response } = await requireApiKey(request);
  if (!auth) {
    return response;
  }

  const body = await readJson<CreateDatabaseBody>(request);
  const name = body?.name?.trim() || "Neo4j Free";

  if (name.length > 80) {
    return json({ error: "Neo4j instance name must be 80 characters or less." }, { status: 400 });
  }

  try {
    // Async: returns as soon as the row exists (status 'provisioning') —
    // see docs/discussion/cli-tool.md and createNeo4jInstanceAsync's doc
    // comment. Kubernetes provisioning continues in the background; poll
    // GET /api/v1/databases/{id} (or `cp db create --wait`) for readiness.
    const created = await createNeo4jInstanceAsync(auth.user_id, auth.api_key_id, name);

    return json(
      {
        instance: created.instance,
        credentials: created.credentials,
      },
      { status: created.instance.status === "ready" ? 201 : 202 },
    );
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
