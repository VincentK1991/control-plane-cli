import type { APIRoute } from "astro";
import { getNeo4jInstanceForUser } from "../../../lib/dbaas/neo4j";
import { json, requireUser } from "../../../lib/responses";

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

  return instance
    ? json({ instance })
    : json({ error: "Neo4j instance not found." }, { status: 404 });
};
