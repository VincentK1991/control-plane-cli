import type { APIRoute } from "astro";
import {
  createSession,
  setSessionCookie,
  upsertUserFromGoogle,
  verifyGoogleCredential,
} from "../../../lib/auth";
import { json, readJson } from "../../../lib/responses";

type LoginBody = {
  credential?: string;
};

export const prerender = false;

export const POST: APIRoute = async ({ request, cookies }) => {
  const body = await readJson<LoginBody>(request);

  if (!body?.credential) {
    return json({ error: "Missing Google credential." }, { status: 400 });
  }

  try {
    const googleUser = await verifyGoogleCredential(body.credential);
    const user = await upsertUserFromGoogle(googleUser);
    const session = await createSession(user.id);
    setSessionCookie(cookies, session.token, session.expiresAt);

    return json({ user });
  } catch (error) {
    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Google authentication failed.",
      },
      { status: 401 },
    );
  }
};
