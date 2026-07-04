import type { AstroCookies } from "astro";
import { getCurrentUser } from "./auth";
import { authenticateApiKey, readBearerToken } from "./metering";

export function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

export async function requireUser(cookies: AstroCookies) {
  const user = await getCurrentUser(cookies);

  if (!user) {
    return {
      user: null,
      response: json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  return { user, response: null };
}

/**
 * Auth for the bearer-scoped /api/v1 surface: resolves the calling API key
 * from the Authorization header alone. Routes built on this must never also
 * accept an apiKeyId from the path/body — the token is the only source of
 * identity, so there is nothing to cross-check it against.
 */
export async function requireApiKey(request: Request) {
  const token = readBearerToken(request);

  if (!token) {
    return {
      auth: null,
      response: json({ error: "Missing bearer API key." }, { status: 401 }),
    };
  }

  const authenticated = await authenticateApiKey(token);

  if (!authenticated) {
    return {
      auth: null,
      response: json({ error: "Invalid or revoked API key." }, { status: 401 }),
    };
  }

  return { auth: authenticated, response: null };
}

export async function readJson<T>(request: Request) {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}
