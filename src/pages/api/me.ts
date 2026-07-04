import type { APIRoute } from "astro";
import { getCurrentUser } from "../../lib/auth";
import { json } from "../../lib/responses";

export const prerender = false;

export const GET: APIRoute = async ({ cookies }) => {
  const user = await getCurrentUser(cookies);

  if (!user) {
    return json({ user: null }, { status: 401 });
  }

  return json({ user });
};
