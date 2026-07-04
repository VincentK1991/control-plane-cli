import type { APIRoute } from "astro";
import {
  createNeo4jInstance,
  DbaasError,
  listNeo4jInstances,
} from "../../../../../lib/dbaas/neo4j";
import { json, readJson, requireUser } from "../../../../../lib/responses";

type CreateNeo4jBody = {
  name?: string;
};

export const prerender = false;

export const GET: APIRoute = async ({ params, cookies }) => {
  const { user, response } = await requireUser(cookies);

  if (!user) {
    return response;
  }

  const apiKeyId = params.apiKeyId;

  if (!apiKeyId) {
    return json({ error: "Missing API key ID." }, { status: 400 });
  }

  try {
    return json({ instances: await listNeo4jInstances(user.id, apiKeyId) });
  } catch (error) {
    return dbaasErrorResponse(error);
  }
};

export const POST: APIRoute = async ({ params, request, cookies }) => {
  const { user, response } = await requireUser(cookies);

  if (!user) {
    return response;
  }

  const apiKeyId = params.apiKeyId;

  if (!apiKeyId) {
    return json({ error: "Missing API key ID." }, { status: 400 });
  }

  const body = await readJson<CreateNeo4jBody>(request);
  const name = body?.name?.trim() || "Neo4j Free";

  if (name.length > 80) {
    return json({ error: "Neo4j instance name must be 80 characters or less." }, { status: 400 });
  }

  try {
    const created = await createNeo4jInstance(user.id, apiKeyId, name);

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
