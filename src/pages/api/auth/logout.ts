import type { APIRoute } from "astro";
import { revokeCurrentSession } from "../../../lib/auth";
import { json } from "../../../lib/responses";

export const prerender = false;

export const POST: APIRoute = async ({ cookies }) => {
  await revokeCurrentSession(cookies);
  return json({ ok: true });
};
