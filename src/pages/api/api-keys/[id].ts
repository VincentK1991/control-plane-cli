import type { APIRoute } from "astro";
import { renameApiKey, revokeApiKey } from "../../../lib/apiKeys";
import { json, readJson, requireUser } from "../../../lib/responses";

type UpdateApiKeyBody = {
  name?: string;
  status?: "revoked";
};

export const prerender = false;

export const PATCH: APIRoute = async ({ params, request, cookies }) => {
  const { user, response } = await requireUser(cookies);

  if (!user) {
    return response;
  }

  const id = params.id;

  if (!id) {
    return json({ error: "Missing API key ID." }, { status: 400 });
  }

  const body = await readJson<UpdateApiKeyBody>(request);

  if (body?.status === "revoked") {
    const revoked = await revokeApiKey(user.id, id);
    return revoked
      ? json({ apiKey: revoked })
      : json({ error: "API key not found." }, { status: 404 });
  }

  const name = body?.name?.trim();

  if (!name) {
    return json({ error: "API key name is required." }, { status: 400 });
  }

  if (name.length > 80) {
    return json({ error: "API key name must be 80 characters or less." }, { status: 400 });
  }

  const renamed = await renameApiKey(user.id, id, name);
  return renamed
    ? json({ apiKey: renamed })
    : json({ error: "API key not found." }, { status: 404 });
};

export const DELETE: APIRoute = async ({ params, cookies }) => {
  const { user, response } = await requireUser(cookies);

  if (!user) {
    return response;
  }

  const id = params.id;

  if (!id) {
    return json({ error: "Missing API key ID." }, { status: 400 });
  }

  const revoked = await revokeApiKey(user.id, id);
  return revoked
    ? json({ apiKey: revoked })
    : json({ error: "API key not found." }, { status: 404 });
};
